import Foundation
import Testing
@testable import ReviewGateCore

/// r1-git: git in auto mode on the Mac (docs/PROTOCOL.md §46, §31.3) — only what throws work away or rewrites the remote
/// keeps the red card (one call at a time, and the card says why); Claude's own commit keeps its file in the review with a
/// "커밋됨" badge; what Claude's git commands did is a chat row, never the head-moved bar.
@Suite @MainActor struct GitAutoTests {
    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "GitAutoTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: .reviewing, canSend: true, canRequestChanges: false, blockedReason: nil, collectError: nil, pendingCount: 1,
                          changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    private func rows(_ store: AppState) -> [(String, ErrorRowInfo)] {
        store.transcript.compactMap { if case let .error(_, message, _, info) = $0 { return (message, info) } else { return nil } }
    }

    private func bash(_ id: String, _ command: String, reason: PermissionReason? = nil) -> PermissionRequest {
        PermissionRequest(requestId: id, toolName: "Bash", input: .object(["command": .string(command)]), file: nil, toolUseId: "t-\(id)", reason: reason)
    }

    @Test func theRedCardSaysWhyItIsOneCallAtATime() {
        let git = bash("G1", "git reset --hard origin/main", reason: PermissionReason(code: .gitCommand, message: "x"))
        #expect(PermissionReasonText.line(git.reason!) == "A git command that throws away uncommitted work or rewrites the remote — the review cannot bring it back")
        #expect(PermissionReasonText.level(git.reason!) == .danger)
        #expect(!PermissionCardOptions(request: git).allowsRemember)
        #expect(PermissionCardOptions.onceOnlyHelp(git)?.hasPrefix("Allowed one call at a time — this git command") == true)
        let nested = bash("N1", "cd sub && make", reason: PermissionReason(code: .nestedRepository, message: "x", path: "/work/acme/sub"))
        #expect(PermissionCardOptions.onceOnlyHelp(nested)?.hasPrefix("Allowed one call at a time — this call works where") == true)
        // A commit has no reason (§46): the ordinary card, which "allow for session" remembers.
        let commit = bash("C1", "git commit -m x")
        #expect(PermissionCardOptions.onceOnlyHelp(commit) == nil)
        #expect(PermissionCardOptions(request: commit).allowsRemember)
    }

    @Test func committedInAndClaudesOwnHeadMoveDecode() throws {
        let file = try JSONDecoder().decode(ChangedFile.self, from: Data(#"{"path":"src/App.java","oldPath":null,"status":"M","added":1,"deleted":0,"isBinary":false,"committedIn":"abc1234"}"#.utf8))
        #expect(file.committedIn == "abc1234")
        let plain = try JSONDecoder().decode(ChangedFile.self, from: Data(#"{"path":"a.txt","oldPath":null,"status":"M","added":1,"deleted":0,"isBinary":false,"committedIn":""}"#.utf8))
        #expect(plain.committedIn == nil)
        let move = try JSONDecoder().decode(HeadMove.self, from: Data(#"{"from":{"sha":"1111111aaa","branch":"main"},"to":{"sha":"2222222bbb","branch":"main"},"explainedBy":"claude_git","commits":["2222222"]}"#.utf8))
        #expect(move.isClaudesOwn && move.commits == ["2222222"])
        let theirs = try JSONDecoder().decode(HeadMove.self, from: Data(#"{"from":{"sha":"1","branch":"main"},"to":{"sha":"2","branch":"main"}}"#.utf8))
        #expect(!theirs.isClaudesOwn && theirs.commits.isEmpty)
        #expect(GitNoticeText.committedBadge("abc1234") == "Committed abc1234")
    }

    @Test func claudesOwnMoveIsNeverTheBar() {
        var gate = snapshot(seq: 1).gate
        gate.headMoved = HeadMove(from: HeadInfo(sha: "1111111", branch: "main"), to: HeadInfo(sha: "2222222", branch: "main"), explainedBy: "claude_git", commits: ["2222222"])
        #expect(ReviewNotices.build(gate: gate, scope: .init(project: "/work/acme", turn: "s#1"), dismissed: []).isEmpty)
        gate.headMoved = HeadMove(from: HeadInfo(sha: "1111111", branch: "main"), to: HeadInfo(sha: "2222222", branch: "main"))
        #expect(ReviewNotices.build(gate: gate, scope: .init(project: "/work/acme", turn: "s#1"), dismissed: []).count == 1)
    }

    @Test func whatClaudesGitDidIsARowNeverABanner() {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1)))
        let cases: [(String, String, String, NoticeStyle)] = [
            ("claude_committed", "abc1234", "Claude committed abc1234 — its files stay in the review", .info),
            ("claude_moved_head", "main@abc1234 → feature/acme-7@abc1234", "Claude's git command moved HEAD (main@abc1234 → feature/acme-7@abc1234) — the review shows only Claude's changes", .info),
            ("git_stashed", "src/App.java, README.md", "Stashed and out of the review: src/App.java, README.md (git stash pop brings them back)", .info),
            ("reject_committed", "src/App.java (abc1234)", "Reverted on disk — Claude's commit still holds the change: src/App.java (abc1234) (git reset --soft or git revert undoes it)", .info),
        ]
        for (code, detail, text, style) in cases {
            var d = EngineErrorDetail(code: code)
            d.detail = detail
            #expect(EngineMessages.error(message: "english", detail: d) == text)
            #expect(SessionNotices.isNotice(code: code, fatal: false))
            #expect(SessionNotices.style(code: code, fatal: false) == style)
            #expect(SessionNotices.secondaryLine(message: "english", detail: d) == nil)
            store.handle(.error(message: "english", fatal: false, scope: .session, detail: d))
        }
        #expect(rows(store).map(\.0) == cases.map(\.2))
        #expect(store.errorBanner == nil)
        #expect(store.lastError == nil)
        #expect(store.queuePausedReason == nil)
    }
}
