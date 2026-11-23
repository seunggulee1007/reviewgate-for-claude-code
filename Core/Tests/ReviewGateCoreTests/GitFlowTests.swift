import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §61 on the Swift side: a new branch takes work in progress along, each switch refusal says its own
/// reason, and Create PR waits for a branch other than the default one.
@MainActor
@Suite struct GitFlowTests {
    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "GitFlowTests.\(UUID().uuidString)")!)
    }

    private func state(branch: String?, defaultBranch: String?, switchBlocker: BranchSwitchBlocker? = nil, createBlocker: BranchSwitchBlocker? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: branch, remoteURL: nil)
        s.branches = BranchesInfo(list: [], isWorktreeDirty: true, switchBlocker: switchBlocker, createBlocker: createBlocker, defaultBranch: defaultBranch)
        return s
    }

    @Test func eachSwitchRefusalSaysItsOwnReason() {
        #expect(EngineMessages.refusal(code: "switch_blocked", error: "switch_blocked:pendingReview") == "Finish the review before switching branches")
        #expect(EngineMessages.refusal(code: "switch_blocked", error: "switch_blocked:dirtyWorktree")
            == "Working tree has uncommitted changes — commit them before switching branches")
        #expect(EngineMessages.refusal(code: "switch_blocked", error: "switch_blocked:running") == "Claude is working — switch branches when the turn ends")
        #expect(EngineMessages.refusal(error: "switch_blocked") == "Branches cannot be switched right now")
    }

    @Test func prRefusalsNameTheBranch() {
        #expect(EngineMessages.refusal(code: "pr_same_branch", error: "pr_same_branch:main") == "You're on main, the base branch — create a branch for this work first")
        #expect(EngineMessages.refusal(code: "pr_no_commits", error: "pr_no_commits:origin/main") == "This branch has no commits since origin/main")
    }

    @Test func branchesDecodeTheNewFieldsAndOlderEnginesWithoutThem() throws {
        let now = try NDJSON.decode(BranchesInfo.self, from: #"{"list":[],"isWorktreeDirty":true,"switchBlocker":{"kind":"dirtyWorktree"},"createBlocker":null,"defaultBranch":"main"}"#)
        #expect(now.switchBlocker == .dirtyWorktree)
        #expect(now.createBlocker == nil)
        #expect(now.defaultBranch == "main")
        let older = try NDJSON.decode(BranchesInfo.self, from: #"{"list":[],"isWorktreeDirty":false,"switchBlocker":null}"#)
        #expect(older.createBlocker == nil)
        #expect(older.defaultBranch == nil)
        // The engine's golden state while a file is pending: switching waits, a new branch does not.
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        let golden = try String(contentsOf: url.appendingPathComponent("engine/test/fixtures/wire/state.reviewing.json"), encoding: .utf8)
        let branches = try NDJSON.decode(ReviewState.self, from: golden).branches
        #expect(branches.switchBlocker == .pendingReview(1))
        #expect(branches.createBlocker == nil)
        #expect(branches.defaultBranch == "main")
    }

    @Test func aNewBranchIsBlockedOnlyByTheCreateBlocker() {
        let store = makeStore()
        store.handle(.state(state(branch: "main", defaultBranch: "main", switchBlocker: .dirtyWorktree)))
        #expect(store.branchSwitchBlocker() == .dirtyWorktree)
        #expect(store.branchCreateBlocker() == nil)
        var s = state(branch: "main", defaultBranch: "main", switchBlocker: .running, createBlocker: .running)
        s.seq = 2
        store.handle(.state(s))
        #expect(store.branchCreateBlocker() == .running)
    }

    @Test func createPRWaitsForABranchOtherThanTheDefaultOneNotForACleanTree() {
        let store = makeStore()
        store.handle(.state(state(branch: "main", defaultBranch: "main", switchBlocker: .dirtyWorktree)))
        #expect(store.prCreateBlocker == "You're on main, the base branch — create a branch for this work first")
        var s = state(branch: "feature/cart", defaultBranch: "main", switchBlocker: .pendingReview(2))
        s.seq = 2
        store.handle(.state(s))
        #expect(store.prCreateBlocker == nil)   // a dirty tree or a pending review no longer blocks it
        s = state(branch: nil, defaultBranch: "main")
        s.seq = 3
        store.handle(.state(s))
        #expect(store.prCreateBlocker == "Check out a branch first (HEAD is detached)")
        s = state(branch: "main", defaultBranch: nil)
        s.seq = 4
        store.handle(.state(s))
        #expect(store.prCreateBlocker == nil)   // an unknown default: the sheet and the engine decide
    }
}
