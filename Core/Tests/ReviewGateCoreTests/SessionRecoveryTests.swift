import Foundation
import Testing
@testable import ReviewGateCore

/// wave1 mac-session: `send` as request/reply (handoff M7), the notices that never stop the queue (M4 / §2.9), the
/// session start / recovery banners and their merged rows (§30), the worktree notices (§33.4) and `ready`.
@Suite @MainActor struct SessionRecoveryTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "SessionRecoveryTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase = .reviewing, canSend: Bool? = nil, ready: Bool? = true,
                          external: ExternalTurn? = nil, open: Bool = true, workbenches: [String] = []) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: open, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil,
                                canRestart: true)
        s.session.ready = ready
        s.session.externalTurn = external
        let sendable = canSend ?? ((phase == .reviewing || phase == .idle) && external == nil)
        s.gate = GateInfo(phase: phase, canSend: sendable, canRequestChanges: false, blockedReason: sendable ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: nil, lastReviewSummary: nil)
        if !workbenches.isEmpty {
            s.workbenches = WorkbenchesInfo(list: workbenches.map { WorkbenchInfo(path: $0, branch: "b", head: "h", isMain: false, isCurrent: false, locked: nil, dirty: nil) },
                                            current: "/repo", managedRoot: "/wb")
        }
        return s
    }

    private func sends(_ commands: [EngineCommand]) -> [String] {
        commands.compactMap { if case let .send(text, _, _, _) = $0 { return text }; return nil }
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
    }

    private func errorRows(_ app: AppState) -> [(message: String, fatal: Bool, info: ErrorRowInfo)] {
        app.transcript.compactMap { if case let .error(_, m, f, i) = $0 { return (m, f, i) }; return nil }
    }

    private static let external = ExternalTurn(commandUuid: "c9", since: "2026-10-22T01:00:00Z",
                                               peer: ExternalTurn.Peer(from: "uds:/tmp/cc-socks/1.sock", fromName: "term"))

    // MARK: - M7: send as request/reply

    /// Handoff §6 (Mac): the queue's message is refused `gate_closed:external_turn` (the external turn started between the
    /// snapshot and the send) — it stays at the front, the queue is not paused, and it goes out once the turn is over.
    @Test func gateClosedRefusalKeepsTheMessageAtTheFrontAndSendsItLater() async {
        let app = makeState()
        var requests: [EngineCommand] = []
        var refuseNext = true
        app.requestSink = { command in
            requests.append(command)
            if case .send = command, refuseNext {
                refuseNext = false
                throw EngineClientError.refused("gate_closed:external_turn", code: "gate_closed")
            }
        }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("first")
        app.enqueue("second")
        #expect(sends(requests).isEmpty)
        // The turn ends; the queue sends "first" — and the engine says an external turn has just started.
        app.handle(.state(snapshot(seq: 2, phase: .reviewing)))
        await waitUntil { app.queuedMessages.count == 2 }
        #expect(sends(requests) == ["first"])
        #expect(app.queuedMessages.map(\.text) == ["first", "second"])
        #expect(app.queuePausedReason == nil)
        #expect(app.transcript.isEmpty && app.errorBanner == nil)   // not an error
        // The external turn shows up: nothing goes out; the composer and the queue say why.
        app.handle(.state(snapshot(seq: 3, external: Self.external)))
        #expect(sends(requests) == ["first"])
        #expect(app.queueHoldReason == PeerText.waitForExternalTurn)
        #expect(app.cannotSendReason == PeerText.externalTurnComposer(Self.external))
        // It ends: "first" goes out by itself, then "second" after that turn.
        app.handle(.state(snapshot(seq: 4)))
        await waitUntil { sends(requests).count == 2 }
        #expect(sends(requests) == ["first", "first"])
        #expect(app.queuedMessages.map(\.text) == ["second"])
        app.handle(.state(snapshot(seq: 5, phase: .running)))
        app.handle(.state(snapshot(seq: 6)))
        await waitUntil { sends(requests).count == 3 }
        #expect(sends(requests) == ["first", "first", "second"])
        #expect(app.queuedMessages.isEmpty && app.queuePausedReason == nil)
    }

    /// A refusal that arrives before the snapshot showing the closed gate must not resend into the same gate.
    @Test func noResendBeforeANewerSnapshot() async {
        let app = makeState()
        var requests: [EngineCommand] = []
        app.requestSink = { command in
            requests.append(command)
            if case .send = command { throw EngineClientError.refused("gate_closed:external_turn", code: "gate_closed") }
        }
        app.handle(.state(snapshot(seq: 1)))
        app.send("hello")
        await waitUntil { !app.queuedMessages.isEmpty }
        #expect(app.queuedMessages.map(\.text) == ["hello"])   // a manual send that was refused waits in the queue
        app.drainQueue()
        app.drainQueue()
        #expect(sends(requests) == ["hello"])   // still seq 1: no loop
        app.handle(.state(snapshot(seq: 2)))
        await waitUntil { sends(requests).count == 2 }
        #expect(sends(requests) == ["hello", "hello"])
    }

    @Test func otherRefusalsStopTheQueueWithTheMessageKept() async {
        let app = makeState()
        app.requestSink = { command in
            if case .send = command { throw EngineClientError.refused("too_many_attachments", code: "too_many_attachments") }
        }
        app.handle(.state(snapshot(seq: 1)))
        app.send("with images")
        await waitUntil { app.queuePausedReason != nil }
        #expect(app.queuedMessages.map(\.text) == ["with images"])
        #expect(app.queuePausedReason == EngineMessages.refusal(error: "too_many_attachments"))
        #expect(errorRows(app).count == 1)
    }

    /// `send_failed` / `lfs_missing` (snapshot A failed): the message is not lost — it waits at the front of the stopped queue.
    @Test func failedSendGoesBackToTheStoppedQueue() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        app.send("needs lfs")
        #expect(sends(sent) == ["needs lfs"])
        app.handle(.error(message: "git-lfs filter failed", fatal: false, scope: .git, detail: EngineErrorDetail(code: "lfs_missing")))
        #expect(app.queuedMessages.map(\.text) == ["needs lfs"])
        #expect(app.queuePausedReason == SessionNotices.lfsMissingText)
        #expect(app.errorBanner?.message == SessionNotices.lfsMissingText && app.errorBanner?.style == .warning)
        // Resume sends it again.
        app.resumeQueue()
        #expect(sends(sent) == ["needs lfs", "needs lfs"])
    }

    /// Once the message's turn is over, a later `send_failed` (a request-changes turn, a rewind) does not bring it back.
    @Test func aLaterSendFailureDoesNotResendAnEarlierMessage() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        app.send("first")
        app.handle(.state(snapshot(seq: 2, phase: .running)))
        app.handle(.state(snapshot(seq: 3)))   // its turn is over
        app.handle(.error(message: "Could not send", fatal: false, scope: .session, detail: EngineErrorDetail(code: "send_failed")))
        #expect(app.queuedMessages.isEmpty)
        #expect(sends(sent) == ["first"])
    }

    // MARK: - M4 / §2.9: notices do not stop the queue

    @Test(arguments: ["resume_not_found", "resume_failed", "worktree_blocked", "worktree_outside_review", "peer_release_failed", "unprompted_blocked"])
    func noticesKeepTheQueueRunning(_ code: String) {
        let app = makeState()
        var sent: [EngineCommand] = []
        var attention: [AttentionEvent] = []
        app.commandSink = { sent.append($0) }
        app.onAttention = { attention.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("next")
        app.handle(.error(message: "notice", fatal: false, scope: .session,
                          detail: EngineErrorDetail(code: code, detail: nil, sessionId: "old", toolName: "EnterWorktree", path: "/repo/.claude/worktrees/x", branch: "x")))
        #expect(app.queuePausedReason == nil)
        #expect(!attention.contains { $0.kind == .actionNeeded })
        #expect(app.lastError == nil)   // a notice is not "the last error"
        #expect(errorRows(app).count == 1)   // still a row (§30: what the user saw stays in the chat)
        app.handle(.state(snapshot(seq: 2)))
        #expect(sends(sent) == ["next"])
    }

    @Test func fatalSessionErrorsStillStopTheQueue() {
        let app = makeState()
        var sent: [EngineCommand] = []
        var attention: [AttentionEvent] = []
        app.commandSink = { sent.append($0) }
        app.onAttention = { attention.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("next")
        app.handle(.error(message: "Claude Code exited while starting.", fatal: true, scope: .session,
                          detail: EngineErrorDetail(code: "session_start_failed", detail: "boom", exitCode: 1)))
        app.handle(.state(snapshot(seq: 2)))
        #expect(sends(sent).isEmpty && app.queuePausedReason != nil)
        #expect(attention.filter { $0.kind == .actionNeeded }.count == 1)
        #expect(app.errorBanner?.style == .error)
    }

    // MARK: - §30 banners, merged rows

    /// Handoff §6 #18: the same `session_start_failed` five times → one row (×5), "new chat" first.
    @Test func repeatedStartFailureIsOneRowWithNewChatFirst() {
        let app = makeState()
        app.commandSink = { _ in }
        app.handle(.state(snapshot(seq: 1, ready: false)))
        for _ in 0..<5 {
            app.handle(.error(message: "Claude Code exited while starting.", fatal: true, scope: .session,
                              detail: EngineErrorDetail(code: "session_start_failed", detail: "error: unknown option '--x'", exitCode: 1)))
        }
        let rows = errorRows(app)
        #expect(rows.count == 1)
        #expect(rows.first?.info.count == 5)
        #expect(rows.first?.message == "Claude Code quit right after it started.")
        #expect(rows.first?.info.secondary == "error: unknown option '--x' · Exit code 1")
        #expect(app.errorBanner?.repeatCount == 5)
        #expect(app.errorBanner?.actions.first == .newChat)
        #expect(app.errorBanner?.actions == [.newChat, .restartSession, .openLogs])
        #expect(app.errorBanner?.secondary == "error: unknown option '--x' · Exit code 1")
        // Another detail is another failure: a row of its own.
        app.handle(.error(message: "Claude Code exited while starting.", fatal: true, scope: .session,
                          detail: EngineErrorDetail(code: "session_start_failed", detail: "other", exitCode: 2)))
        #expect(errorRows(app).count == 2)
    }

    @Test func repeatedCrashPutsNewChatFirst() {
        let app = makeState()
        let crash = EngineError(message: "query loop threw", detail: EngineErrorDetail(code: "session_crashed", detail: "Session ID x is already in use.", exitCode: 1))
        app.handle(crash.event)
        #expect(app.errorBanner?.actions == [.restartSession, .newChat])
        app.handle(crash.event)
        #expect(app.errorBanner?.actions == [.newChat, .restartSession])
        #expect(errorRows(app).first?.info.count == 2)
    }

    /// A new user turn in between makes the same error a new row.
    @Test func aUserMessageEndsTheMerge() {
        let app = makeState()
        app.fail("Could not send", fatal: false)
        app.fail("Could not send", fatal: false)
        #expect(errorRows(app).map(\.info.count) == [2])
        app.handle(.userMessage(text: "again", turn: 2))
        app.fail("Could not send", fatal: false)
        #expect(errorRows(app).map(\.info.count) == [2, 1])
    }

    /// Handoff §6 #19: `resume_not_found` reads as information (not red) with "show the previous chat".
    @Test func resumeNotFoundIsAnInfoNotice() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        app.handle(.error(message: "Claude Code has no record…", fatal: false, scope: .session,
                          detail: EngineErrorDetail(code: "resume_not_found", detail: "No conversation found with session ID: old", sessionId: "old")))
        #expect(app.errorBanner?.style == .info)
        #expect(app.errorBanner?.actions == [.showPreviousChat])
        #expect(app.errorBanner?.sessionId == "old")
        #expect(app.errorBanner?.message.contains("30") == true)
        #expect(app.queuePausedReason == nil)
    }

    /// Handoff §6 #21: `ready` false → true clears the crash banner (and only that one).
    @Test func readyClearsTheCrashBanner() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        app.handle(.error(message: "query loop threw", fatal: true, scope: .session, detail: EngineErrorDetail(code: "session_crashed")))
        app.handle(.state(snapshot(seq: 2, ready: false)))
        #expect(app.errorBanner != nil)
        app.handle(.state(snapshot(seq: 3, ready: true)))
        #expect(app.errorBanner == nil)
        #expect(errorRows(app).count == 1)   // the row stays

        app.handle(.error(message: "git switch failed", fatal: false, scope: .git))
        app.handle(.state(snapshot(seq: 4, ready: false)))
        app.handle(.state(snapshot(seq: 5, ready: true)))
        #expect(app.errorBanner?.message == "git switch failed")   // not a session death
        // Older engines (no `ready`) never clear it.
        app.handle(.error(message: "query loop threw", fatal: true, scope: .session, detail: EngineErrorDetail(code: "session_crashed")))
        app.handle(.state(snapshot(seq: 6, ready: nil)))
        app.handle(.state(snapshot(seq: 7, ready: nil)))
        #expect(app.errorBanner?.code == "session_crashed")
    }

    @Test func startingIsShownUntilReady() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, ready: false)))
        #expect(app.isClaudeCodeStarting)
        app.handle(.state(snapshot(seq: 2, ready: true)))
        #expect(!app.isClaudeCodeStarting)
        app.handle(.state(snapshot(seq: 3, ready: nil)))   // an older engine
        #expect(!app.isClaudeCodeStarting)
    }

    // MARK: - §33.4 worktree notices

    /// Handoff §6 #16: the blocked EnterWorktree's banner keeps its branch for the new-workbench sheet.
    @Test func worktreeBlockedKeepsTheBranchForTheWorkbenchSheet() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        app.handle(.error(message: "Claude tried to work in a git worktree (\"feature-x\"); …", fatal: false, scope: .session,
                          detail: EngineErrorDetail(code: "worktree_blocked", detail: nil, toolName: "EnterWorktree", path: "/repo/.claude/worktrees/feature-x", branch: "feature-x")))
        #expect(app.errorBanner?.branch == "feature-x")
        #expect(app.errorBanner?.actions == [.openWorkbench])
        #expect(app.errorBanner?.style == .warning)
        #expect(app.errorBanner?.message.contains("feature-x") == true)
        for (tool, needle) in [("Workflow", "workflow"), ("Agent", "isolated"), ("Task", "isolated")] {
            let text = SessionNotices.errorText(message: "m", detail: EngineErrorDetail(code: "worktree_blocked", detail: nil, toolName: tool))
            #expect(text?.localizedCaseInsensitiveContains(needle) == true, "\(tool)")
        }
    }

    @Test func worktreeOutsideReviewOpensTheWorkbenchOrTheFolder() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, workbenches: ["/wb/feature"])))
        app.handle(.error(message: "Bash worked outside this window's review (/wb/feature): …", fatal: false, scope: .session,
                          detail: EngineErrorDetail(code: "worktree_outside_review", detail: nil, toolName: "Bash", path: "/wb/feature")))
        // wave4b w4b-follow (§39.4): a worktree of this repository — the chat can follow it there first.
        #expect(app.errorBanner?.actions == [.moveChat, .openWorkbench])
        app.handle(.error(message: "m", fatal: false, scope: .session,
                          detail: EngineErrorDetail(code: "worktree_outside_review", detail: nil, toolName: "Bash", path: "/repo/vendor/lib")))
        #expect(app.errorBanner?.actions == [.openFolder])
        #expect(app.errorBanner?.message.contains("/repo/vendor/lib") == true)
    }

    /// Handoff §6 #17 / #20: notices and errors come back from `transcript_restore` as rows, worded and merged like live ones.
    @Test func restoredErrorRowsAreWordedAndMerged() {
        let app = makeState()
        let items = [
            TranscriptItem(at: "2026-10-22T01:00:00Z", turn: 1, kind: .userMessage(text: "go")),
            TranscriptItem(at: "2026-10-22T01:00:01Z", turn: 1, kind: .error(message: "Claude tried to work in a git worktree (\"fx\"); ReviewGate blocked it …", fatal: false, scope: .session, code: "worktree_blocked", detail: nil)),
            TranscriptItem(at: "2026-10-22T01:00:01Z", turn: 1, kind: .error(message: "Claude tried to work in a git worktree (\"fx\"); ReviewGate blocked it …", fatal: false, scope: .session, code: "worktree_blocked", detail: nil)),
            TranscriptItem(at: "2026-10-22T01:00:02Z", turn: 1, kind: .error(message: "Claude Code exited while starting.", fatal: true, scope: .session, code: "session_start_failed", detail: "boom")),
            TranscriptItem(at: "2026-10-22T01:00:03Z", turn: 1, kind: .error(message: "Claude Code exited while starting.", fatal: true, scope: .session, code: "session_start_failed", detail: "boom")),
            TranscriptItem(at: "2026-10-22T01:00:04Z", turn: 1, kind: .error(message: "Bash worked outside this window's review (/x/y): those changes …", fatal: false, scope: .session, code: "worktree_outside_review", detail: nil)),
        ]
        app.handle(.transcriptRestore(items: items))
        let rows = errorRows(app)
        #expect(rows.count == 3)
        #expect(rows[0].message.contains("fx"))   // the branch read back from the engine's text
        #expect(rows[0].info.code == "worktree_blocked" && rows[0].info.count == 2)   // a repeated notice merges too
        #expect(rows[1].info.count == 2 && rows[1].info.secondary == "boom")
        #expect(rows[1].info.lastAt == AppState.isoDate("2026-10-22T01:00:03Z"))
        #expect(rows[2].message.contains("/x/y"))
        #expect(app.restoredTranscriptIDs.count == 4)   // user row + three error rows
        // A live repeat of a restored error is a row of its own (the restored ones belong to a previous run).
        app.handle(.error(message: "Claude Code exited while starting.", fatal: true, scope: .session,
                          detail: EngineErrorDetail(code: "session_start_failed", detail: "boom")))
        #expect(errorRows(app).count == 4)
    }

    @Test func secondaryLineAndRepeatWording() {
        let start = SessionNotices.secondaryLine(message: "spawn claude ENOENT", detail: EngineErrorDetail(code: "session_start_failed"))
        #expect(start == "spawn claude ENOENT")
        #expect(SessionNotices.secondaryLine(message: SessionNotices.genericStartFailure, detail: EngineErrorDetail(code: "session_start_failed")) == nil)
        #expect(SessionNotices.secondaryLine(message: "m", detail: EngineErrorDetail(code: "session_crashed", detail: "d", exitCode: nil, signal: "SIGKILL"))
                == "d · Signal SIGKILL")
        #expect(SessionNotices.secondaryLine(message: "m", detail: EngineErrorDetail(code: "auth_required")) == nil)
        let utc = TimeZone(identifier: "UTC")!
        let at = Date(timeIntervalSince1970: 1_792_490_000)   // 2026-10-20 09:53 UTC
        #expect(SessionNotices.repeatText(count: 1, lastAt: at) == nil)
        #expect(SessionNotices.repeatText(count: 3, lastAt: at, timeZone: utc, locale: Locale(identifier: "en_US"))?.hasPrefix("×3 · last 9:53") == true)
        #expect(SessionNotices.abbreviatingHome("/Users/me/work/x", home: "/Users/me") == "~/work/x")
        #expect(SessionNotices.abbreviatingHome("/Users/meme/x", home: "/Users/me") == "/Users/meme/x")
    }

    @Test func everyNewCodeHasWords() {
        for code in ["session_start_failed", "session_crashed", "resume_not_found", "resume_failed", "session_id_in_use",
                     "peer_release_failed", "lfs_missing", "worktree_blocked", "worktree_outside_review"] {
            let text = EngineMessages.error(message: "English fallback", detail: EngineErrorDetail(code: code))
            #expect(!text.isEmpty && text != "English fallback", "\(code)")
        }
        for code in ["peer_none", "peer_inbox_changed", "peer_unsupported", "peer_release_failed", "peer_dismiss_failed", "invalid_peer_mode"] {
            #expect(EngineMessages.refusal(error: code) != code, "\(code)")
        }
        #expect(EngineMessages.refusal(error: "gate_closed:external_turn") == PeerText.waitForExternalTurn)
        #expect(EngineMessages.refusal(error: "gate_closed:running") == EngineMessages.gateText("running"))
    }
}

/// A test-side shorthand for a fatal session error event.
private struct EngineError {
    var message: String
    var detail: EngineErrorDetail
    var event: EngineEvent { .error(message: message, fatal: true, scope: .session, detail: detail) }
}
