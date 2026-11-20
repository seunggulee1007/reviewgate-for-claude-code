import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §59 on the Swift side: `project.vcs`, `track_without_git {confirm}` and its refusals in the user's words.
@MainActor
@Suite struct TrackWithoutGitTests {
    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(id: nil, command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "TrackWithoutGitTests.\(UUID().uuidString)")!)
    }

    private func pendingPrompt(_ store: AppState, unsafe: Bool = false) {
        var s = ReviewState.empty
        s.seq = 1
        s.gitInit = GitInitInfo(path: "/work/acme-notes", candidates: [], looksUnsafe: unsafe)
        store.handle(.state(s))
    }

    // MARK: - Wire

    @Test func projectVcsDecodesAndDefaultsToGit() throws {
        let shadow = try NDJSON.decode(ProjectInfo.self, from: #"{"path":"/work/acme-notes","root":"/work/acme-notes","name":"acme-notes","branch":null,"remoteURL":null,"commonDir":"/Users/dev/.reviewgate/shadow-repos/acme-notes-0123456789abcdef","vcs":"shadow"}"#)
        #expect(shadow.vcs == .shadow)
        #expect(shadow.branch == nil)
        let older = try NDJSON.decode(ProjectInfo.self, from: #"{"path":"/work/acme","root":"/work/acme","name":"acme","branch":"main","remoteURL":null}"#)
        #expect(older.vcs == .git)
        let unknown = try NDJSON.decode(ProjectInfo.self, from: #"{"path":"/work/acme","root":"/work/acme","name":"acme","branch":"main","remoteURL":null,"vcs":"hg"}"#)
        #expect(unknown.vcs == .git)
        // The engine's golden state of a repository says "git".
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        let golden = try String(contentsOf: url.appendingPathComponent("engine/test/fixtures/wire/state.reviewing.json"), encoding: .utf8)
        #expect(try NDJSON.decode(ReviewState.self, from: golden).project?.vcs == .git)
    }

    @Test func trackWithoutGitSendsConfirmOnlyWhenSet() throws {
        let plain = try json(.trackWithoutGit())
        #expect(plain["type"] as? String == "track_without_git")
        #expect(plain["confirm"] == nil)
        let confirmed = try json(.trackWithoutGit(confirm: true))
        #expect(confirmed["type"] as? String == "track_without_git")
        #expect(confirmed["confirm"] as? Bool == true)
    }

    // MARK: - The store

    @Test func aShadowProjectSaysWhyGitThingsAreOff() {
        let store = makeStore()
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        store.handle(.state(s))
        #expect(!store.isShadowProject)
        #expect(store.notGitRepositoryReason == nil)
        s.seq = 2
        s.project = ProjectInfo(path: "/work/acme-notes", root: "/work/acme-notes", name: "acme-notes", branch: nil, remoteURL: nil, vcs: .shadow)
        store.handle(.state(s))
        #expect(store.isShadowProject)
        #expect(store.notGitRepositoryReason == "This folder is not a git repository")
    }

    @Test func whatNeedsARepositoryIsOffWithItsReason() async {
        let store = makeStore()
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/work/acme-notes", root: "/work/acme-notes", name: "acme-notes", branch: nil, remoteURL: nil, vcs: .shadow)
        store.handle(.state(s))
        let reason = "This folder is not a git repository"
        #expect(store.commitLockReason == reason)
        #expect(!store.canOpenCommitSheet)
        #expect(store.chatMoveBlocker == reason)
        #expect(store.planWorkbenchBlocker == reason)
        #expect(await store.loadCommitFormat() == nil)
        await settle { store.menuState.isShadowProject }
        #expect(store.menuState.isShadowProject)
        #expect(!store.menuState.canCommit)
    }

    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<100 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func anUnsafeFolderAsksFirstAndTheConfirmGoesOnTheWire() async {
        let store = makeStore()
        pendingPrompt(store, unsafe: true)
        var sent: [EngineCommand] = []
        store.requestSink = { command in
            sent.append(command)
            if command == .trackWithoutGit() { throw EngineClientError.refused("folder_unsafe", code: "folder_unsafe") }
        }
        #expect(await store.trackWithoutGit() == .needsConfirm)
        #expect(store.gitInitProblem == nil)
        #expect(await store.trackWithoutGit(confirm: true) == .tracked)
        #expect(sent == [.trackWithoutGit(), .trackWithoutGit(confirm: true)])
    }

    @Test func aTooLargeFolderNamesTheLimitAndKeepsThePrompt() async {
        let store = makeStore()
        pendingPrompt(store)
        for (limit, words) in [("files", "20,000 files"), ("bytes", "1 GB"), ("scan", "took too long")] {
            store.requestSink = { _ in throw EngineClientError.refused("folder_too_large:\(limit)", code: "folder_too_large") }
            guard case let .refused(text) = await store.trackWithoutGit() else { Issue.record("not refused"); continue }
            #expect(text.contains(words), "\(limit): \(text)")
            #expect(text.contains("Initialize a git repository"))
            #expect(store.gitInitProblem == text)
            #expect(store.needsGitInit)
        }
        store.requestSink = { _ in throw EngineClientError.refused("track_failed: git: command not found", code: "track_failed") }
        #expect(await store.trackWithoutGit() == .refused("Could not track this folder without git: git: command not found"))
        // The prompt going away takes its problem along.
        store.handle(.state(ReviewState.empty.with(seq: 9)))
        #expect(store.gitInitProblem == nil)
    }

    @Test func aLockedFolderGoesToTheTakeoverAlert() async {
        let store = makeStore()
        pendingPrompt(store)
        store.requestSink = { _ in throw EngineClientError.refused("locked_by_other_session:4242", code: "locked_by_other_session") }
        #expect(await store.trackWithoutGit() == .locked)
        #expect(store.lockConflict?.pid == 4242)
        #expect(store.gitInitProblem == nil)
    }

    @Test func aReopenThatFailedSaysWhyInThePrompt() {
        let store = makeStore()
        store.handle(.error(message: "folder_too_large:bytes — the folder holds more than 1073741824 bytes (12 files, 2147483648 bytes counted); open a smaller folder or make it a git repository",
                            fatal: false, scope: .git, detail: EngineErrorDetail(code: "folder_too_large")))
        pendingPrompt(store)
        #expect(store.gitInitProblem?.contains("1 GB") == true)
        #expect(store.errorBanner?.message.contains("1 GB") == true)
    }

    @Test func notAGitRepoRefusalsAreWords() {
        #expect(EngineMessages.refusal(code: "not_a_git_repo", error: "not_a_git_repo:pr_list").contains("not a git repository"))
        #expect(EngineMessages.refusal(error: "folder_too_large:files").contains("20,000 files"))
        #expect(EngineMessages.error(message: "boom", detail: EngineErrorDetail(code: "track_failed")) == "Could not track this folder without git: boom")
    }
}

private extension ReviewState {
    func with(seq: Int) -> ReviewState {
        var s = self
        s.seq = seq
        return s
    }
}
