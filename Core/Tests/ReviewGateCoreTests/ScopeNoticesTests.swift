import Foundation
import Testing
@testable import ReviewGateCore

/// r1-scope: docs/PROTOCOL.md §33.4 / §39.5 on the Mac — what a command changed outside this window's review is a chat row
/// (never a banner, never the last error) naming the files, with the folder's actions.
@Suite @MainActor struct ScopeNoticesTests {
    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ScopeNoticesTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, workbenches: [String] = []) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: .running, canSend: false, canRequestChanges: false, blockedReason: nil, collectError: nil, pendingCount: 0,
                          changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil)
        s.workbenches = WorkbenchesInfo(list: workbenches.map { WorkbenchInfo(path: $0, branch: "acme-42", head: "abc", isMain: false, isCurrent: false, locked: nil, dirty: nil) },
                                        current: "/work/acme", managedRoot: "/work")
        return s
    }

    private func rows(_ store: AppState) -> [(message: String, info: ErrorRowInfo)] {
        store.transcript.compactMap { if case let .error(_, message, _, info) = $0 { return (message, info) } else { return nil } }
    }

    private func outside(_ path: String, _ files: [String]?) -> EngineErrorDetail {
        var d = EngineErrorDetail(code: "worktree_outside_review")
        d.toolName = "Bash"
        d.path = path
        d.files = files
        return d
    }

    @Test func aCommandsChangesNextDoorAreARowWithTheFilesAndTheFoldersActions() {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1, workbenches: ["/work/acme-42"])))
        store.handle(.error(message: "Bash worked outside this window's review (/work/acme-42): … Changed: made.txt", fatal: false, scope: .session,
                            detail: outside("/work/acme-42", ["made.txt"])))
        #expect(store.errorBanner == nil)
        #expect(store.lastError == nil)
        #expect(store.queuePausedReason == nil)
        let r = rows(store)
        #expect(r.count == 1)
        #expect(r[0].message == "Changed where this window's review does not see it: /work/acme-42")
        #expect(r[0].info.secondary == "made.txt")
        #expect(r[0].info.path == "/work/acme-42")
        #expect(SessionNotices.style(code: "worktree_outside_review", fatal: false) == .info)
        #expect(ScopeText.rowActions(r[0].info, isWorkbench: store.isWorkbenchPath) == [.moveChat, .openWorkbench])
        // Another call that changed other files: its own row (never folded into ×2); the same files again fold.
        store.handle(.error(message: "x", fatal: false, scope: .session, detail: outside("/work/acme-42", ["src/b.ts"])))
        store.handle(.error(message: "x", fatal: false, scope: .session, detail: outside("/work/acme-42", ["src/b.ts"])))
        #expect(rows(store).map(\.info.secondary) == ["made.txt", "src/b.ts"])
        #expect(rows(store).last?.info.count == 2)
        // A folder that is no worktree of this repository (a nested clone): open it as a folder.
        store.handle(.error(message: "x", fatal: false, scope: .session, detail: outside("/work/acme/vendor/lib", ["lib.txt"])))
        #expect(ScopeText.rowActions(rows(store).last!.info, isWorkbench: store.isWorkbenchPath) == [.openFolder])
        #expect(store.errorBanner == nil)
    }

    @Test func filesLineNamesTheFirstFilesAndCountsTheRest() {
        #expect(ScopeText.filesLine([]) == nil)
        #expect(ScopeText.filesLine(["a.txt", "b/c.ts"]) == "a.txt, b/c.ts")
        let many = (1...10).map { "f\($0).txt" }
        #expect(ScopeText.filesLine(many) == "f1.txt, f2.txt, f3.txt, f4.txt, f5.txt, f6.txt, f7.txt, f8.txt and 2 more")
        // Without files (an older engine, or git could not tell) the §33.4 sentence stands.
        #expect(ScopeText.errorText(message: "m", detail: outside("/work/acme-42", nil)) == nil)
        #expect(EngineMessages.error(message: "m", detail: outside("/work/acme-42", nil)).contains("/work/acme-42"))
    }

    @Test func filesComeOverTheWireAndBackWithARestoredRow() throws {
        let line = #"{"type":"error","message":"m","fatal":false,"scope":"session","code":"worktree_outside_review","toolName":"Bash","path":"/work/acme-42","files":["made.txt",3,"src/b.ts"]}"#
        guard case let .error(_, _, _, detail) = try JSONDecoder().decode(EngineEvent.self, from: Data(line.utf8)) else {
            Issue.record("not an error event"); return
        }
        #expect(detail.files == ["made.txt", "src/b.ts"])
        let old = #"{"type":"error","message":"m","fatal":false,"scope":"session","code":"worktree_outside_review","path":"/w"}"#
        guard case let .error(_, _, _, none) = try JSONDecoder().decode(EngineEvent.self, from: Data(old.utf8)) else {
            Issue.record("not an error event"); return
        }
        #expect(none.files == nil)

        let row = #"{"at":"2026-11-06T01:00:00Z","turn":1,"kind":"error","message":"Bash worked outside this window's review (/work/acme-42): … Changed: made.txt","fatal":false,"scope":"session","code":"worktree_outside_review","toolName":"Bash","path":"/work/acme-42","files":["made.txt"]}"#
        let item = try JSONDecoder().decode(TranscriptItem.self, from: Data(row.utf8))
        let store = makeStore()
        store.handle(.transcriptRestore(items: [TranscriptItem(at: "2026-11-06T00:59:00Z", turn: 1, kind: .userMessage(text: "go")), item]))
        let r = rows(store)
        #expect(r.count == 1)
        #expect(r[0].message == "Changed where this window's review does not see it: /work/acme-42")
        #expect(r[0].info.secondary == "made.txt" && r[0].info.path == "/work/acme-42")
    }
}
