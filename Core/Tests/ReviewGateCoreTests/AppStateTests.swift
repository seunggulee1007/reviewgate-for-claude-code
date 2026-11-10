import Foundation
import Testing
@testable import ReviewGateCore

/// M13 client-side review state driven through `AppState.handle(_:)` without an engine (the client spawns lazily
/// at the first command, and nothing here sends one).
@Suite @MainActor struct AppStateTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "AppStateTests.\(UUID().uuidString)")!)
    }

    private func reviewing(seq: Int, files: [ChangedFile], tree: String = "B1", restored: Bool = false,
                           outside: [String] = [], ignored: [String] = [], filtered: [String] = [],
                           sessionOpen: Bool = true) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: sessionOpen, starting: false, sessionId: "s", model: nil, capabilities: nil,
                                pendingPermission: nil, canRestart: true)
        // A standing review does not close the input (docs/PROTOCOL.md §10): only a dead session does.
        s.gate = GateInfo(phase: .reviewing, canSend: sessionOpen, canRequestChanges: true, blockedReason: sessionOpen ? nil : .pendingReview,
                          collectError: nil, pendingCount: files.filter { $0.state == .pending }.count, changesRequestedCount: 0,
                          isRequestingChanges: false, turnStartTree: "A1", turnEndTree: tree, lastReviewSummary: nil,
                          changedOutside: outside, ignoredTouched: ignored, filteredByPattern: filtered, restored: restored)
        s.changedFiles = files
        return s
    }

    private func file(_ path: String, _ state: FileReviewState = .pending) -> ChangedFile {
        ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: state)
    }

    @Test func errorBannerFollowsErrorEventsAndDismiss() {
        let app = makeState()
        #expect(app.errorBanner == nil)
        app.handle(.error(message: "git switch failed", fatal: false, scope: .git))
        #expect(app.errorBanner == ErrorBanner(message: "git switch failed", scope: .git, fatal: false))
        #expect(app.lastError == "git switch failed")
        app.handle(.error(message: "engine exited", fatal: true, scope: .engine))
        #expect(app.errorBanner?.scope == .engine && app.errorBanner?.fatal == true)
        app.dismissErrorBanner()
        #expect(app.errorBanner == nil)
        #expect(app.transcript.count == 2)   // the rows stay
    }

    /// Release review H3: accept / reject wait while a turn runs or its changes are being collected (the engine
    /// refuses them with `session_running`); the client neither sends them nor stays silent about it.
    @Test func reviewActionsWaitForTheTurnAndCollection() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let a = file("a.txt")
        for (seq, phase) in [(1, GatePhase.running), (2, .collecting), (3, .reverting)] {
            var s = reviewing(seq: seq, files: [a, file("b.txt")])
            s.gate.phase = phase
            app.handle(.state(s))
            #expect(app.isReviewLocked)
            app.accept(a)
            app.reject(a)
            app.acceptAll()
            app.rejectAll()
            #expect(sent.isEmpty)
            // wave2 mac-flow (§34.2): a running turn says when reject comes back; the last refusal here is reject all's.
            let expected = phase == .running ? String(localized: "Reject is available when this turn ends", bundle: .module)
                : AppState.sessionRefusalText(phase == .reverting ? "reverting" : "session_running")
            #expect(app.lastError == expected)
        }
        app.handle(.state(reviewing(seq: 4, files: [a, file("b.txt")])))
        #expect(!app.isReviewLocked)
        app.accept(a)
        app.rejectAll()
        #expect(sent == [.accept(paths: ["a.txt"]), .rejectAll()])
        #expect(AppState.sessionRefusalText("session_running") == AppState.sessionRefusalText("session_busy"))
    }

    /// Release review H4: an engine that stops while a project is open resets the window to the empty state; the
    /// banner (shown above it) says so and offers to reopen the project.
    @Test func engineExitShowsReopenBanner() {
        let app = makeState()
        app.handle(.state(reviewing(seq: 3, files: [file("a.txt")])))
        app.handle(.error(message: "sidecar exited 1", fatal: true, scope: .engine))
        app.handle(.state(.empty))
        #expect(app.projectURL == nil)
        let stopped = String(localized: "The engine has stopped.", bundle: .module)
        #expect(app.errorBanner == ErrorBanner(message: "\(stopped) sidecar exited 1", scope: .engine, fatal: true,
                                               reopenProject: URL(fileURLWithPath: "/repo")))
        #expect(!app.isEngineRunning)
    }

    /// Release review H4: a failed engine start (here: the sidecar script is missing) is not just an invisible
    /// transcript row — the banner carries it, with "Reopen" for the folder that was being opened.
    @Test func engineStartFailureSetsBanner() async {
        let app = makeState()
        let url = URL(fileURLWithPath: "/tmp/rg-missing-project")
        await app.openProject(url)
        #expect(app.errorBanner?.scope == .engine)
        #expect(app.errorBanner?.fatal == true)
        #expect(app.errorBanner?.reopenProject == url)
        #expect(app.errorBanner?.message == app.lastError)
    }

    @Test func transcriptRestorePrefillsAndMarksRows() {
        let app = makeState()
        app.handle(.transcriptRestore(items: [
            TranscriptItem(at: "t", turn: 1, kind: .userMessage(text: "hi")),
            TranscriptItem(at: "t", turn: 1, kind: .assistantText(text: "pong")),
            TranscriptItem(at: "t", turn: 1, kind: .other(kind: "future")),
            TranscriptItem(at: "t", turn: 1, kind: .turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 10),
                                                            files: 1, added: 1, deleted: 0, changedOutside: [])),
        ]))
        #expect(app.transcript.count == 3)
        #expect(app.restoredTranscriptIDs == Set(app.transcript.map(\.id)))
        guard case let .user(_, text, _) = app.transcript[0] else { Issue.record("first row is not the user message"); return }
        #expect(text == "hi")
        guard case .assistant(_, "pong", false, false) = app.transcript[1] else { Issue.record("second row is not the assistant text"); return }
        // Live rows after the restore are not marked.
        app.handle(.userMessage(text: "next", turn: 2))
        #expect(app.transcript.count == 4 && !app.restoredTranscriptIDs.contains(app.transcript[3].id))
        app.handle(.transcriptRestore(items: []))
        #expect(app.transcript.count == 4)
    }

    @Test func unpromptedTextIsItsOwnMarkedRow() {
        let app = makeState()
        app.handle(.userMessage(text: "go", turn: 1))
        app.handle(.textDelta(text: "Done."))
        // The CLI continues on its own: a new, marked row — never appended to the user's turn text.
        app.handle(.textDelta(text: "Background ", unprompted: true))
        app.handle(.textDelta(text: "finished.", unprompted: true))
        app.handle(.textDelta(text: "Back to normal."))
        #expect(app.transcript.count == 4)
        guard case .assistant(_, "Done.", false, false) = app.transcript[1] else { Issue.record("prompted row: \(app.transcript[1])"); return }
        guard case .assistant(_, "Background finished.", false, true) = app.transcript[2] else { Issue.record("unprompted row: \(app.transcript[2])"); return }
        guard case .assistant(_, "Back to normal.", true, false) = app.transcript[3] else { Issue.record("last row: \(app.transcript[3])"); return }
        // Restored rows keep the mark.
        app.handle(.transcriptRestore(items: [TranscriptItem(at: "t", turn: 1, kind: .assistantText(text: "old bg", unprompted: true))]))
        guard case .assistant(_, "old bg", false, true) = app.transcript[0] else { Issue.record("restored row: \(app.transcript[0])"); return }
    }

    private func withSessions(_ base: ReviewState, seq: Int, list: [SessionMeta], current: String?, tabs: [String]) -> ReviewState {
        var s = base
        s.seq = seq
        s.sessions = SessionsInfo(list: list, currentId: current, openTabIds: tabs)
        return s
    }

    @Test func chatSessionsTabsAndRestoreReplacement() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        #expect(!app.hasChatSessions && app.openTabs.isEmpty && app.chatSwitchBlocker == nil)

        var idle = reviewing(seq: 1, files: [])
        idle.gate.phase = .idle
        idle.gate.blockedReason = nil
        idle.gate.turnEndTree = nil
        let s1 = SessionMeta(id: "s1", title: "First", turns: 1, costUSD: 0.1)
        let s2 = SessionMeta(id: "s2", title: "New chat")
        // The current session is missing from the stored tabs: the client persists it once.
        app.handle(.state(withSessions(idle, seq: 1, list: [s2, s1], current: "s2", tabs: ["s1"])))
        #expect(app.hasChatSessions && app.currentSessionId == "s2")
        #expect(app.openTabs.map(\.id) == ["s1", "s2"])
        #expect(sent.last == .tabsSet(openTabIds: ["s1", "s2"]))
        app.handle(.state(withSessions(idle, seq: 2, list: [s2, s1], current: "s2", tabs: ["s1"])))   // same sessions again → no resend
        #expect(sent.filter { if case .tabsSet = $0 { return true }; return false }.count == 1)

        // Live rows, then a tab switch: the restore after `session_open` replaces the transcript.
        app.handle(.userMessage(text: "ping", turn: 1))
        app.handle(.textDelta(text: "pong"))
        #expect(app.transcript.count == 2)
        #expect(await app.openChat(id: "s1"))
        #expect(sent.last == .sessionOpen(id: "s1"))
        app.handle(.transcriptRestore(items: [TranscriptItem(at: "t", turn: 1, kind: .userMessage(text: "old")),
                                              TranscriptItem(at: "t", turn: 1, kind: .assistantText(text: "older"))]))
        #expect(app.transcript.count == 2 && app.restoredTranscriptIDs.count == 2)
        guard case .user(_, "old", _) = app.transcript[0] else { Issue.record("transcript was not replaced"); return }
        // A plain restore (open_project) still pre-fills.
        app.handle(.transcriptRestore(items: [TranscriptItem(at: "t", turn: 0, kind: .userMessage(text: "earlier"))]))
        #expect(app.transcript.count == 3)
        // `session_new` → empty restore clears everything.
        #expect(await app.newChat())
        #expect(sent.last == .sessionNew)
        app.handle(.transcriptRestore(items: []))
        #expect(app.transcript.isEmpty && app.restoredTranscriptIDs.isEmpty)
        #expect(!(await app.openChat(id: "s2")))   // already current

        // Closing tabs: a non-current tab is just dropped; the current one switches to its neighbour first.
        app.handle(.state(withSessions(idle, seq: 3, list: [s2, s1], current: "s2", tabs: ["s1", "s2"])))
        #expect(await app.closeTab(id: "s1"))
        #expect(sent.last == .tabsSet(openTabIds: ["s2"]))
        app.handle(.state(withSessions(idle, seq: 4, list: [s2, s1], current: "s2", tabs: ["s1", "s2"])))
        #expect(await app.closeTab(id: "s2"))
        #expect(sent.suffix(2).first == .sessionOpen(id: "s1") && sent.last == .tabsSet(openTabIds: ["s1"]))
        app.handle(.state(withSessions(idle, seq: 5, list: [s2, s1], current: "s2", tabs: ["s2"])))
        #expect(!(await app.closeTab(id: "s2")))   // the only tab stays

        // Blockers: a plainly pending review no longer blocks (see chatSwitchBlockerMatrix); a busy gate does.
        app.handle(.state(withSessions(reviewing(seq: 9, files: [file("a")]), seq: 6, list: [s2, s1], current: "s2", tabs: ["s1", "s2"])))
        #expect(app.chatSwitchBlocker == nil)
        var running = idle
        running.gate.phase = .running
        app.handle(.state(withSessions(running, seq: 7, list: [s2, s1], current: "s2", tabs: ["s1", "s2"])))
        #expect(app.chatSwitchBlocker == AppState.sessionRefusalText("session_busy"))
        #expect(!(await app.closeTab(id: "s2")))
        #expect(AppState.sessionRefusalText("session_busy:running") == AppState.sessionRefusalText("session_busy"))
        #expect(AppState.sessionRefusalText("weird_code") == "weird_code")
        app.handle(.state(withSessions(idle, seq: 8, list: [s2, s1], current: "s2", tabs: ["s1", "s2"])))

        // Rename / archive / delete / refresh go out as commands; delete refuses the current chat.
        app.renameChat(id: "s1", title: "  Renamed ")
        #expect(sent.last == .sessionRename(id: "s1", title: "Renamed"))
        app.archiveChat(id: "s1", archived: true)
        #expect(sent.last == .sessionArchive(id: "s1", archived: true))
        #expect(!(await app.deleteChat(id: "s2")))
        #expect(await app.deleteChat(id: "s1"))
        #expect(sent.last == .sessionDelete(id: "s1"))
        await app.refresh(scope: [.review])
        #expect(sent.last == .refresh(scope: [.review]) && !app.isRefreshing)
    }

    /// `chatSwitchBlocker` mirrors the engine's `guardSessionSwitch()`: busy first, then a failed collection. r2-chats-cards
    /// M31 (§9): the review never blocks — pending files, unsent notes and a change request are worktree state that survives
    /// the switch — and [+] / ⌘T (`newChatBlocker`) only wait while Claude works.
    @Test func chatSwitchBlockerMatrix() {
        let app = makeState()
        let list = [SessionMeta(id: "s1", title: "First"), SessionMeta(id: "s2", title: "Second")]
        var seq = 0
        func show(_ state: ReviewState) {
            seq += 1
            app.handle(.state(withSessions(state, seq: seq, list: list, current: "s2", tabs: ["s1", "s2"])))
        }

        // Pending files only → allowed.
        show(reviewing(seq: 0, files: [file("a"), file("b")]))
        #expect(app.hasPendingReview && app.chatSwitchBlocker == nil)

        // Unsent notes and a change request no longer block (M31).
        var noted = reviewing(seq: 0, files: [file("a")])
        noted.reviewNotes = [ReviewNote(id: "n1", path: "a", line: 1, side: .new, excerpt: "x", body: "why?")]
        show(noted)
        #expect(app.chatSwitchBlocker == nil && app.newChatBlocker == nil && !app.chatSwitchWaits)
        show(reviewing(seq: 0, files: [file("a", .changesRequested)]))
        #expect(app.chatSwitchBlocker == nil && app.newChatBlocker == nil)

        // A failed collection → collect_failed (the Retry belongs to this chat).
        var failed = reviewing(seq: 0, files: [file("a")])
        failed.gate.phase = .collectFailed
        failed.gate.collectError = "git add -A failed"
        show(failed)
        #expect(app.chatSwitchBlocker == AppState.sessionRefusalText("collect_failed"))
        #expect(app.newChatBlocker == AppState.sessionRefusalText("collect_failed"))
        #expect(MenuState(app).newChatBlocked)

        // A busy gate outranks all of them.
        for phase in [GatePhase.starting, .running, .collecting, .reverting] {
            var busy = noted
            busy.gate.phase = phase
            show(busy)
            #expect(app.chatSwitchBlocker == AppState.sessionRefusalText("session_busy"))
            #expect(app.newChatBlocker == nil && app.chatSwitchWaits && !MenuState(app).newChatBlocked)   // ⌘T waits
        }

        // Nothing under review → allowed.
        var clean = reviewing(seq: 0, files: [])
        clean.gate.phase = .idle
        show(clean)
        #expect(!app.hasPendingReview && app.chatSwitchBlocker == nil)
        // Without a project nothing is blocked (the command itself is refused with no_project).
        #expect(makeState().chatSwitchBlocker == nil)
    }

    @Test func integritySignalsAndRestoredFlagMirrorTheGate() {
        let app = makeState()
        app.handle(.state(reviewing(seq: 1, files: [file("a")], restored: true, outside: ["/x/y"], ignored: [".env"], filtered: [".omc/s"])))
        #expect(app.isReviewRestored && app.changedOutside == ["/x/y"] && app.ignoredTouched == [".env"] && app.filteredByPattern == [".omc/s"])
        #expect(app.canRestartSession)
        #expect(!app.isSessionEnded)
        #expect(app.cannotSendReason == nil) // a pending review never blocks sending
        app.handle(.state(reviewing(seq: 2, files: [file("a")], sessionOpen: false)))
        #expect(app.isSessionEnded)
        #expect(app.cannotSendReason == String(localized: "Review \(1) pending file(s) to continue", bundle: .module))
    }

    @Test func nextPreviousPendingWrapAndSkipReviewedFiles() async {
        let app = makeState()
        // `select_file` answers with a diff (wave3 check-clients: a file is "viewed" once its diff was on screen, not when
        // a request that may fail was sent); selection + viewedPaths are what we assert.
        app.replySink = { command in
            switch command {
            case .sideList: return .sideThreads(id: nil, mainSessionId: "s", threads: [])
            case let .selectFile(path, _):
                return .fileDiff(id: nil, scope: .turn, path: path, diff: FileDiff(oldPath: path, newPath: path, isBinary: false, hunks: []),
                                 truncated: false, endTree: nil, info: FileDiffInfo())
            default: throw EngineClientError.refused("unknown command \(command.type)")
            }
        }
        app.handle(.state(reviewing(seq: 1, files: [file("a"), file("b", .accepted), file("c"), file("d", .rejected), file("e")])))
        await app.diffLoadTask?.value
        #expect(app.selectedPath == "a")   // first pending auto-selected
        app.selectNextPending()
        await app.diffLoadTask?.value
        #expect(app.selectedPath == "c")
        app.selectNextPending()
        await app.diffLoadTask?.value
        #expect(app.selectedPath == "e")
        app.selectNextPending()
        await app.diffLoadTask?.value
        #expect(app.selectedPath == "a")   // wraps
        app.selectPreviousPending()
        await app.diffLoadTask?.value
        #expect(app.selectedPath == "e")   // wraps backwards
        app.selectPreviousPending()
        await app.diffLoadTask?.value
        #expect(app.selectedPath == "c")
        #expect(app.viewedPaths == ["a", "c", "e"])
        #expect(app.unviewedPendingFiles.isEmpty)

        // A new snapshot B keeps the selection when the file still exists; only a file whose content changed loses its
        // viewed mark (wave2 mac-flow, §34.5 — before, every mark went with B).
        let reEdited = ChangedFile(path: "a", oldPath: nil, status: .modified, added: 3, deleted: 1, isBinary: false, tools: ["Edit"])
        app.handle(.state(reviewing(seq: 2, files: [reEdited, file("c")], tree: "B2")))
        await app.diffLoadTask?.value
        #expect(app.selectedPath == "c" && app.viewedPaths == ["c"])
        #expect(app.unviewedPendingFiles.map(\.path) == ["a"])
        #expect(app.changedSinceViewedFiles.map(\.path) == ["a"])

        // No pending files → no-op.
        app.handle(.state(reviewing(seq: 3, files: [file("a", .accepted)], tree: "B3")))
        app.selectNextPending()
        #expect(app.selectedPath == "a")
    }

    // MARK: - M14 AskUserQuestion

    private static let askInput: JSONValue = .object([
        "questions": .array([
            .object(["question": .string("Which color?"), "header": .string("Color"), "multiSelect": .bool(false),
                     "options": .array([.object(["label": .string("red"), "description": .string("warm")]),
                                        .object(["label": .string("green"), "description": .string("cool"), "preview": .string("#0f0")])])]),
            .object(["question": .string("Which features?"), "header": .string("Features"), "multiSelect": .bool(true),
                     "options": .array([.object(["label": .string("auth"), "description": .string("")]),
                                        .object(["label": .string("sync"), "description": .string("")])])]),
        ]),
    ])

    @Test func askUserQuestionDecodesLenientlyAndOnlyForThatTool() throws {
        let req = PermissionRequest(requestId: "q1", toolName: "AskUserQuestion", input: Self.askInput)
        let q = try #require(AskUserQuestions(request: req))
        #expect(q.questions.map(\.question) == ["Which color?", "Which features?"])
        #expect(q.questions[0].header == "Color" && !q.questions[0].multiSelect && q.questions[1].multiSelect)
        #expect(q.questions[0].options.map(\.label) == ["red", "green"])
        #expect(q.questions[0].options[1].preview == "#0f0" && q.questions[0].options[0].preview == nil)
        #expect(q.answers.isEmpty)
        #expect(AskUserQuestions(request: PermissionRequest(requestId: "b", toolName: "Bash", input: Self.askInput)) == nil)
        #expect(AskUserQuestions(request: PermissionRequest(requestId: "e", toolName: "AskUserQuestion", input: .object([:]))) == nil)
        #expect(AskUserQuestions.answerText(selectedLabels: ["auth", "sync"], other: "  ") == "auth, sync")
        #expect(AskUserQuestions.answerText(selectedLabels: [], other: " purple ") == "purple")
        #expect(AskUserQuestions.answerText(selectedLabels: ["auth"], other: "logs") == "auth, logs")
    }

    @Test func answerQuestionsSendsAllowWithQuestionsPassthroughAndAnswers() throws {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let req = PermissionRequest(requestId: "q1", toolName: "AskUserQuestion", input: Self.askInput)
        app.handle(.permissionRequest(req))
        #expect(app.pendingQuestions?.questions.count == 2)

        app.answerQuestions(answers: ["Which color?": "green", "Which features?": "auth, sync"])
        #expect(app.pendingPermission == nil && app.pendingQuestions == nil)
        guard case let .permissionResponse(requestId, allow, message, updatedInput, _)? = sent.last else {
            Issue.record("no permission_response sent"); return
        }
        #expect(requestId == "q1" && allow && message == nil)
        let updated = try #require(updatedInput)
        #expect(updated["questions"] == Self.askInput["questions"])   // original array passed through untouched
        #expect(updated["answers"] == .object(["Which color?": .string("green"), "Which features?": .string("auth, sync")]))
        let wire = try JSONSerialization.jsonObject(with: NDJSON.encodeLine(EngineCommandEnvelope(command: sent.last!))) as? [String: Any]
        let answers = try #require(wire?["updatedInput"] as? [String: Any]).map { $0["answers"] as? [String: String] }
        #expect(answers == ["Which color?": "green", "Which features?": "auth, sync"])

        // The transcript row now carries the answers for the read-only card.
        guard case let .permission(_, r, allowed)? = app.transcript.last else { Issue.record("no permission row"); return }
        #expect(allowed == true && AskUserQuestions(request: r)?.answers["Which color?"] == "green")

        // Skip → deny with the skip message; another tool's request is not answerable through this path.
        app.handle(.permissionRequest(req))
        app.skipQuestions()
        guard case let .permissionResponse(_, allow2, message2, updated2, _)? = sent.last else { Issue.record("no skip response"); return }
        #expect(!allow2 && message2 == "User skipped the questions" && updated2 == nil)
        app.handle(.permissionRequest(PermissionRequest(requestId: "b", toolName: "Bash", input: .object([:]))))
        let count = sent.count
        app.answerQuestions(answers: ["x": "y"])
        #expect(sent.count == count && app.pendingPermission?.requestId == "b")
    }

    // MARK: M16 friction (docs/M16-FRICTION.md)

    @Test func acceptAndSendOnlyWhilePendingWithoutChangesRequested() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(reviewing(seq: 1, files: [file("a.txt"), file("b.txt", .accepted)])))
        #expect(app.canSend && app.canAcceptAndSend)
        // Older engine (no `reviewSummary`): computed from the pending files.
        #expect(app.reviewSummary == ReviewSummary(files: 1, added: 1, deleted: 0))
        app.send("go", acceptPending: true)
        #expect(sent.last == .send(text: "go", acceptPending: true))
        // Without the flag the message goes out as a plain send: nothing is accepted.
        app.send("ask")
        #expect(sent.count == 2 && sent.last == .send(text: "ask", acceptPending: false))

        // A changes-requested file offers no accept-and-send (those go through Request changes)…
        app.handle(.state(reviewing(seq: 2, files: [file("a.txt"), file("c.txt", .changesRequested)])))
        #expect(!app.canAcceptAndSend)
        app.send("go", acceptPending: true)
        #expect(sent.count == 3 && sent.last == .send(text: "go", acceptPending: false)) // …the flag is dropped, the question is sent

        // The engine's summary (totals over every changed file) is used while all of them are pending…
        var open = reviewing(seq: 3, files: [file("a.txt")])
        open.gate.reviewSummary = ReviewSummary(files: 1, added: 12, deleted: 3)
        app.handle(.state(open))
        #expect(app.reviewSummary == ReviewSummary(files: 1, added: 12, deleted: 3))
        // …but once some are accepted only the pending ones count.
        var mixed = reviewing(seq: 4, files: [file("a.txt"), file("b.txt", .accepted)])
        mixed.gate.reviewSummary = ReviewSummary(files: 2, added: 2, deleted: 0)
        app.handle(.state(mixed))
        #expect(app.reviewSummary == ReviewSummary(files: 1, added: 1, deleted: 0))
        // Nothing pending: no accept-and-send action.
        var idle = ReviewState.empty
        idle.seq = 5
        idle.gate.canSend = true
        app.handle(.state(idle))
        #expect(app.canSend && !app.canAcceptAndSend)
    }

    @Test func allowForSessionRemembersAndForgetClears() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.permissionRequest(PermissionRequest(requestId: "p1", toolName: "Bash", input: .object(["command": .string("npm test")]))))
        app.respondPermission(allow: true, remember: true)
        #expect(sent.last == .permissionResponse(requestId: "p1", allow: true, message: nil, updatedInput: nil, remember: true))
        // Deny never remembers.
        app.handle(.permissionRequest(PermissionRequest(requestId: "p2", toolName: "Bash", input: .object([:]))))
        app.respondPermission(allow: false, message: "no", remember: true)
        #expect(sent.last == .permissionResponse(requestId: "p2", allow: false, message: "no", updatedInput: nil, remember: false))

        var s = ReviewState.empty
        s.seq = 1
        s.session.rememberedAllows = ["Bash:npm test"]
        app.handle(.state(s))
        #expect(app.rememberedAllows == ["Bash:npm test"])
        app.forgetAllows()
        #expect(sent.last == .forgetAllows && app.rememberedAllows.isEmpty)
        let count = sent.count
        app.forgetAllows()   // nothing to forget → no command
        #expect(sent.count == count)
    }

    /// M20: the mode picker and the plan card produce exactly the commands docs/PROTOCOL.md §11 specifies.
    @Test func permissionModeAndPlanCardCommands() {
        let defaults = UserDefaults(suiteName: "AppStateTests.plan.\(UUID().uuidString)")!
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }

        // An idle session with a project: the picker is live and switching sends `set_permission_mode`.
        app.handle(.state(reviewing(seq: 1, files: [], tree: "B1")))
        #expect(app.permissionMode == .default && app.pendingPlan == nil && app.canSetPermissionMode)
        app.setPermissionMode(.plan)
        #expect(sent.last == .setPermissionMode(mode: .plan))
        #expect(app.permissionMode == .plan)
        #expect(AppSettings.permissionMode(root: "/repo", defaults: defaults) == .plan)   // persisted per project
        let afterSet = sent.count
        app.setPermissionMode(.plan)   // unchanged → no command
        #expect(sent.count == afterSet)

        // Running: the engine would refuse with `session_busy`, so the picker is disabled and sends nothing.
        var running = reviewing(seq: 2, files: [])
        running.session.permissionMode = .plan
        running.gate.phase = .running
        app.handle(.state(running))
        #expect(!app.canSetPermissionMode)
        app.setPermissionMode(.default)
        #expect(sent.count == afterSet && app.permissionMode == .plan)

        // The plan turn has ended: the card's buttons are live again (§19.5 plan lock).
        var planned = reviewing(seq: 3, files: [])
        planned.session.permissionMode = .plan
        app.handle(.state(planned))
        #expect(!app.isPlanLocked)

        // A proposal opens the card and leaves a transcript row behind.
        app.handle(.planProposed(path: "/home/u/.claude/plans/x.md", plan: "# Plan\n- step"))
        #expect(app.pendingPlan == PendingPlan(path: "/home/u/.claude/plans/x.md", plan: "# Plan\n- step"))
        guard case let .plan(_, path, plan, approvedMode) = app.transcript.last else {
            Issue.record("no plan row in the transcript"); return
        }
        #expect(path == "/home/u/.claude/plans/x.md" && plan == "# Plan\n- step" && approvedMode == nil)

        // "Keep planning" with a note; the card closes right away.
        app.keepPlanning(message: "  tighten step 2  ")
        #expect(sent.last == .planResponse(approve: false, mode: nil, message: "tighten step 2"))
        #expect(app.pendingPlan == nil)
        let afterKeep = sent.count
        app.keepPlanning()   // nothing pending → no command
        #expect(sent.count == afterKeep)

        // "Approve & auto-accept edits"; an empty note is omitted.
        app.handle(.planProposed(path: nil, plan: "p"))
        app.approvePlan(mode: .acceptEdits, message: "   ")
        #expect(sent.last == .planResponse(approve: true, mode: .acceptEdits, message: nil))
        #expect(app.pendingPlan == nil)

        // `plan_approved` mirrors the new mode and keeps the approval in the history.
        app.handle(.planApproved(mode: .acceptEdits, path: "/home/u/.claude/plans/x.md"))
        #expect(app.permissionMode == .acceptEdits)
        #expect(AppSettings.permissionMode(root: "/repo", defaults: defaults) == .acceptEdits)
        guard case let .plan(_, _, _, approved) = app.transcript.last else {
            Issue.record("no approval row in the transcript"); return
        }
        #expect(approved == .acceptEdits)

        // The engine clearing `pendingPlan` (a plain send superseded it) closes the card.
        var superseded = reviewing(seq: 4, files: [])
        superseded.session.pendingPlan = PendingPlan(path: nil, plan: "p")
        app.handle(.state(superseded))
        #expect(app.pendingPlan != nil)
        app.handle(.state(reviewing(seq: 5, files: [])))
        #expect(app.pendingPlan == nil)
    }
}
