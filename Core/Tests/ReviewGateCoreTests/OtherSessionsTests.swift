import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 mac-session: the user's other Claude sessions on the Mac (docs/PROTOCOL.md §36.9) — the sidebar's list (status
/// words, folders, order, refreshed at most every few seconds), importing a terminal session as a new chat (the review
/// gate applies from then on) and "Continue in terminal".
@Suite @MainActor struct OtherSessionsTests {
    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "OtherSessionsTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, sessions: [SessionMeta] = [], current: String? = nil, phase: GatePhase = .idle) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/Users/me/acme", root: "/Users/me/acme", name: "acme", branch: "develop", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: current, model: nil, capabilities: nil, pendingPermission: nil,
                                canRestart: true)
        s.sessions = SessionsInfo(list: sessions, currentId: current, openTabIds: sessions.map(\.id))
        s.gate = GateInfo(phase: phase, canSend: phase == .idle, canRequestChanges: false, blockedReason: nil, collectError: nil,
                          pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: nil, turnEndTree: nil,
                          lastReviewSummary: nil)
        return s
    }

    private let reply = CliSessionsReply(
        running: [CliRunningSession(pid: 1, sessionId: "a", name: "workers", cwd: "/Users/me/acme-workers", status: .idle, entrypoint: "cli"),
                  CliRunningSession(pid: 2, sessionId: "b", name: nil, cwd: "/Users/me/acme", status: .busy, entrypoint: "cli",
                                    sameWorktree: true),
                  CliRunningSession(pid: 3, sessionId: "c", name: "acme-b4", cwd: "/Users/me/acme-4790", status: .waiting,
                                    entrypoint: "cli")],
        resumable: [CliResumableSession(sessionId: "9f1e", title: "장바구니 합계 수정", updatedAt: "2026-10-23T02:10:00.000Z",
                                        cwd: "/Users/me/acme-4790"),
                    CliResumableSession(sessionId: "77aa", title: "로그 정리", updatedAt: "2026-10-22T09:00:00Z", cwd: nil)])

    // MARK: - Words

    @Test func statusWords() {
        #expect(CliSessionText.status(.busy) == "Working")
        #expect(CliSessionText.status(.waiting) == "Waiting for input")
        #expect(CliSessionText.status(.idle) == "Idle")
        #expect(CliSessionText.status(.unknown) == nil)
    }

    @Test func resumeCommandQuotesTheFolder() {
        #expect(CliSessionText.resumeCommand(folder: "/Users/me/acme", sessionId: "9f1e")
                == "cd /Users/me/acme && claude --resume 9f1e")
        #expect(CliSessionText.resumeCommand(folder: "/Users/me/My Repo", sessionId: "9f1e")
                == "cd '/Users/me/My Repo' && claude --resume 9f1e")
        #expect(CliSessionText.resumeCommand(folder: "/Users/me/it's", sessionId: "9f1e")
                == #"cd '/Users/me/it'\''s' && claude --resume 9f1e"#)
        // An id is never trusted as shell text either.
        #expect(CliSessionText.resumeCommand(folder: "/r", sessionId: "x; rm -rf ~") == #"cd /r && claude --resume 'x; rm -rf ~'"#)
    }

    @Test func folderLabelsAreRelativeToTheWorktrees() {
        let worktrees = ["/Users/me/acme", "/Users/me/acme-4790"]
        #expect(CliSessionText.folder("/Users/me/acme", worktrees: worktrees) == "acme")
        #expect(CliSessionText.folder("/Users/me/acme/batch/module", worktrees: worktrees) == "acme/batch/module")
        #expect(CliSessionText.folder("/Users/me/acme-4790", worktrees: worktrees) == "acme-4790")
        #expect(CliSessionText.folder("/tmp/elsewhere", worktrees: worktrees) == "elsewhere")
        #expect(CliSessionText.folder("", worktrees: worktrees) == "")
    }

    @Test func runningOrderPutsThisFolderAndWaitingFirst() {
        let sorted = CliSessionList.sorted(reply.running)
        #expect(sorted.map(\.pid) == [2, 3, 1])   // this worktree first, then waiting, busy, idle
        let title = CliSessionText.title(reply.running[1], worktrees: ["/Users/me/acme"])
        #expect(title == "acme")   // no name: the folder
        #expect(CliSessionText.title(reply.running[2], worktrees: []) == "acme-b4")
    }

    // MARK: - Refresh

    @Test func refreshKeepsTheListAndThrottles() async {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1)))
        var calls = 0
        let reply = reply
        store.replySink = { command in
            #expect(command == .cliSessions)
            calls += 1
            return .cliSessions(reply)
        }
        let start = Date()
        await store.sessionTools.refreshSessions(now: start)
        #expect(calls == 1)
        #expect(store.sessionTools.running.count == 3)
        #expect(store.sessionTools.resumable.map(\.sessionId) == ["9f1e", "77aa"])
        #expect(store.sessionTools.sessionsLoaded)
        await store.sessionTools.refreshSessions(now: start.addingTimeInterval(3))
        #expect(calls == 1)   // too soon
        await store.sessionTools.refreshSessions(force: true, now: start.addingTimeInterval(3))
        #expect(calls == 2)
        await store.sessionTools.refreshSessions(now: start.addingTimeInterval(30))
        #expect(calls == 3)
        #expect(store.otherClaudeSessions.map(\.pid) == [2, 3, 1])
    }

    @Test func olderEnginesHideTheSection() async {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1)))
        var calls = 0
        store.replySink = { _ in
            calls += 1
            throw EngineClientError.refused("unknown command: cli_sessions", code: "unknown_command")
        }
        await store.sessionTools.refreshSessions(force: true)
        #expect(!store.sessionTools.sessionsSupported)
        #expect(store.sessionTools.sessionsError == nil)
        await store.sessionTools.refreshSessions(force: true)
        #expect(calls == 1)   // not asked again
    }

    @Test func refreshFailureSaysWhyAndKeepsTheLastList() async {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1)))
        let reply = reply
        store.replySink = { _ in .cliSessions(reply) }
        await store.sessionTools.refreshSessions(force: true)
        store.replySink = { _ in throw EngineClientError.exited }
        await store.sessionTools.refreshSessions(force: true)
        #expect(store.sessionTools.running.count == 3)
        #expect(store.sessionTools.sessionsError != nil)
    }

    @Test func noRefreshWithoutAProject() async {
        let store = makeStore()
        var calls = 0
        store.replySink = { _ in calls += 1; return .cliSessions(CliSessionsReply(running: [], resumable: [])) }
        await store.sessionTools.refreshSessions(force: true)
        #expect(calls == 0)
    }

    // MARK: - Import

    @Test func importResumesAsANewChat() async {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1, sessions: [SessionMeta(id: "s1", title: "앱 채팅")], current: "s1")))
        let reply = reply
        store.replySink = { _ in .cliSessions(reply) }
        await store.sessionTools.refreshSessions(force: true)
        var sent: [EngineCommand] = []
        store.replySink = { command in
            sent.append(command)
            return .result(id: "r", ok: true, error: nil)
        }
        let error = await store.sessionTools.importSession("9f1e")
        #expect(error == nil)
        #expect(sent == [.cliSessionImport(sessionId: "9f1e")])
        #expect(store.sessionTools.resumable.map(\.sessionId) == ["77aa"])   // gone from the sheet at once
        #expect(store.sessionTools.importingSessionId == nil)
        #expect(store.replaceTranscriptOnRestore)   // the engine's empty transcript_restore replaces the old chat's rows
    }

    @Test func importRefusalsInTheUsersWords() async {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1)))
        store.replySink = { _ in throw EngineClientError.refused("cli_session_running", code: "cli_session_running") }
        let running = await store.sessionTools.importSession("9f1e")
        #expect(running == CliSessionText.importRefusal(code: "cli_session_running", fallback: ""))
        #expect(running?.isEmpty == false)
        #expect(!store.replaceTranscriptOnRestore)
        store.replySink = { _ in throw EngineClientError.refused("unknown_session", code: "unknown_session") }
        let unknown = await store.sessionTools.importSession("9f1e")
        #expect(unknown == CliSessionText.importRefusal(code: "unknown_session", fallback: ""))
        store.replySink = { _ in throw EngineClientError.refused("session_busy", code: "session_busy") }
        let busy = await store.sessionTools.importSession("9f1e")
        #expect(busy == EngineMessages.refusal(code: "session_busy", error: "session_busy"))
    }

    @Test func importIsBlockedLikeOpeningAChat() {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1, phase: .running)))
        #expect(store.cliImportBlockedReason == store.chatSwitchBlocker)
        #expect(store.cliImportBlockedReason != nil)
        store.handle(.state(snapshot(seq: 2)))
        #expect(store.cliImportBlockedReason == nil)
    }

    // MARK: - Imported chat, continue in terminal

    @Test func importedChatSaysTheGateAppliesFromHereOn() {
        let store = makeStore()
        var imported = SessionMeta(id: "9f1e", title: "장바구니 합계 수정")
        imported.imported = ImportedSession(at: "2026-10-23T03:00:00.000Z", cwd: "/Users/me/acme-4790")
        imported.cliKnown = true
        store.handle(.state(snapshot(seq: 1, sessions: [imported, SessionMeta(id: "s1", title: "앱 채팅")], current: "9f1e")))
        #expect(store.currentImportedSession?.cwd == "/Users/me/acme-4790")
        store.handle(.state(snapshot(seq: 2, sessions: [imported, SessionMeta(id: "s1", title: "앱 채팅")], current: "s1")))
        #expect(store.currentImportedSession == nil)
    }

    @Test func continueInTerminalNeedsAConversationTheCLIKnows() {
        let store = makeStore()
        var known = SessionMeta(id: "5d0c", title: "a", turns: 2)
        var fresh = SessionMeta(id: "new1", title: "b")
        var failed = SessionMeta(id: "old1", title: "c", turns: 3)
        failed.resumeFailed = true
        store.handle(.state(snapshot(seq: 1, sessions: [known, fresh, failed], current: "5d0c")))
        #expect(store.continueInTerminalCommand(for: known) == "cd /Users/me/acme && claude --resume 5d0c")
        #expect(store.continueInTerminalCommand(for: fresh) == nil)
        #expect(store.continueInTerminalCommand(for: failed) == nil)
        fresh.cliKnown = true
        #expect(store.continueInTerminalCommand(for: fresh) == "cd /Users/me/acme && claude --resume new1")
        known.turns = 0
        #expect(store.continueInTerminalCommand(for: known) == nil)
    }

    @Test func resetForgetsTheOtherSessions() async {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1)))
        let reply = reply
        store.replySink = { _ in .cliSessions(reply) }
        await store.sessionTools.refreshSessions(force: true)
        store.sessionTools.reset()
        #expect(store.sessionTools.running.isEmpty)
        #expect(!store.sessionTools.sessionsLoaded)
    }
}
