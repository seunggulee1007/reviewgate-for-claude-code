import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §57.5 on the Mac: a terminal chat is opened like ⌘T (held while Claude works), its spec is asked for,
/// the TUI's waits become attention once each, and Stop goes to the PTY instead of the engine.
@Suite @MainActor struct TerminalChatStateTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "TerminalChatStateTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase, current: String = "t1", terminal: TerminalSessionInfo? = nil,
                          background: [BackgroundTerminalInfo] = [], canRequestChanges: Bool = false) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: current, model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.session.terminal = terminal
        let idle = phase == .idle
        s.gate = GateInfo(phase: phase, canSend: idle, canRequestChanges: canRequestChanges, blockedReason: idle ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil, changedOutside: [], ignoredTouched: [],
                          filteredByPattern: [], restored: false)
        var term = SessionMeta(id: "t1", title: "In the terminal")
        term.kind = .terminal
        var term2 = SessionMeta(id: "t2", title: "Another terminal")
        term2.kind = .terminal
        s.sessions = SessionsInfo(list: [term, SessionMeta(id: "c1", title: "Chat"), term2], currentId: current,
                                  openTabIds: ["t1", "c1", "t2"], backgroundTerminals: background)
        return s
    }

    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    @Test func theChatsKind() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, phase: .idle)))
        #expect(app.currentChatKind == .terminal)
        #expect(app.isTerminalChat)
        #expect(app.shownChatIsTerminal)
        #expect(app.chatKind(id: "c1") == .chat)
        #expect(app.chatKind(id: "gone") == .chat)
        #expect(MenuState(app).isTerminalChat && MenuState(app).shownChatIsTerminal)
        #expect(!MenuState(app).canPickPermissionMode)
        app.handle(.state(snapshot(seq: 2, phase: .idle, current: "c1")))
        #expect(!app.isTerminalChat)
        #expect(app.terminalInfo == nil)
        #expect(!MenuState(app).isTerminalChat)
    }

    @Test func aNewTerminalChatSendsSessionNewWithItsKind() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .idle, current: "c1")))
        #expect(await app.newTerminalChat())
        #expect(fired.last == .sessionNewTerminal)
    }

    @Test func whileClaudeWorksTheNewTerminalChatIsHeld() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running, current: "c1")))
        #expect(await app.newTerminalChat())
        #expect(app.pendingChatSwitch == .newTerminalChat)
        #expect(app.pendingChatSwitch?.chatId == nil)
        #expect(app.pendingChatSwitchText == String(localized: "A new terminal chat opens once Claude is done in '\("Chat")'", bundle: .module))
        #expect(!fired.contains(.sessionNewTerminal))
        app.handle(.state(snapshot(seq: 2, phase: .idle, current: "c1")))
        await eventually { fired.last == .sessionNewTerminal }
        #expect(fired.last == .sessionNewTerminal)
        #expect(app.pendingChatSwitch == nil)
    }

    @Test func theSpecAndThePtysLife() async throws {
        let app = makeState()
        var asked: [EngineCommand] = []
        let spec = TerminalSpec(sessionId: "t1", argv: ["/usr/local/bin/claude", "--session-id=t1"], env: ["RG_HOOK_TOKEN": "x"],
                                cwd: "/work/acme", resume: false)
        app.replySink = { command in
            asked.append(command)
            return .terminalSpec(spec)
        }
        #expect(try await app.terminalSpec(sessionId: "t1") == spec)
        #expect(asked == [.terminalSpec(sessionId: "t1")])

        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.terminalStarted(sessionId: "t1", pid: 4242)
        app.terminalExited(sessionId: "t1", exitCode: nil)
        #expect(fired == [.terminalStarted(sessionId: "t1", pid: 4242), .terminalExited(sessionId: "t1", exitCode: nil)])
    }

    @Test func aRefusedSpecSaysWhy() async {
        let app = makeState()
        app.replySink = { _ in throw EngineClientError.refused("terminal_cli_too_old:2.1.200", code: "terminal_cli_too_old") }
        do {
            _ = try await app.terminalSpec(sessionId: "t1")
            Issue.record("expected a refusal")
        } catch {
            #expect(FlowText.refusal(error) == TerminalChatText.refusal(code: "terminal_cli_too_old"))
        }
    }

    @Test func reviewNowEndsTheOpenTurn() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.requestSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        await app.endTerminalTurn()
        #expect(sent == [.terminalEndTurn(sessionId: "t1")])
        // Closed meanwhile: no error row.
        app.requestSink = { _ in throw EngineClientError.refused("no_turn:", code: "no_turn") }
        await app.endTerminalTurn()
        #expect(app.lastError == nil)
    }

    @Test func aWaitInTheTerminalIsRaisedOnce() {
        let app = makeState()
        var raised: [AttentionEvent] = []
        app.onAttention = { raised.append($0) }
        let waiting = TerminalWaiting(kind: .permission, message: "Claude needs your permission to use Bash", since: "2026-11-16T10:00:00Z")
        app.handle(.state(snapshot(seq: 1, phase: .running, terminal: TerminalSessionInfo(running: true, hooksSeen: true))))
        #expect(raised.isEmpty)
        app.handle(.state(snapshot(seq: 2, phase: .running, terminal: TerminalSessionInfo(running: true, hooksSeen: true, waiting: waiting))))
        app.handle(.state(snapshot(seq: 3, phase: .running, terminal: TerminalSessionInfo(running: true, hooksSeen: true, waiting: waiting))))
        #expect(raised.count == 1)
        #expect(raised.first?.kind == .permission)
        #expect(raised.first?.kind.blocksClaude == true)
        #expect(raised.first?.key == "term:t1:2026-11-16T10:00:00Z")
        #expect(raised.first?.body == "Claude needs your permission to use Bash")
        #expect(app.terminalWaiting == waiting)
        // Answered, then a new wait (a question): raised again.
        app.handle(.state(snapshot(seq: 4, phase: .running, terminal: TerminalSessionInfo(running: true, hooksSeen: true))))
        let question = TerminalWaiting(kind: .question, message: "Which one?", since: "2026-11-16T10:01:00Z")
        app.handle(.state(snapshot(seq: 5, phase: .running, terminal: TerminalSessionInfo(running: true, hooksSeen: true, waiting: question))))
        #expect(raised.count == 2)
        #expect(raised.last?.kind == .question)
    }

    @Test func stopOnATerminalChatGoesToThePty() {
        let app = makeState()
        var fired: [EngineCommand] = []
        var escapes = 0
        app.commandSink = { fired.append($0) }
        app.onTerminalInterrupt = { escapes += 1 }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.interrupt()
        #expect(escapes == 1)
        #expect(!fired.contains(.interrupt))
        // A chat-kind chat still interrupts through the engine.
        app.handle(.state(snapshot(seq: 2, phase: .running, current: "c1")))
        app.interrupt()
        #expect(escapes == 1)
        #expect(fired.contains(.interrupt))
    }

    @Test func restartOnATerminalChatRestartsItsPty() {
        let app = makeState()
        var fired: [EngineCommand] = []
        var restarts = 0
        app.commandSink = { fired.append($0) }
        app.onTerminalRestart = { restarts += 1 }
        app.handle(.state(snapshot(seq: 1, phase: .idle)))
        // Settings' "Restart now", the reconnect and the banner's "Restart session": the PTY, never `restart_session`.
        app.restartSession()
        app.reconnectSession()
        app.restartSessionFromBanner()
        #expect(restarts == 3)
        #expect(!fired.contains(.restartSession))
        // A chat-kind chat still restarts through the engine.
        app.handle(.state(snapshot(seq: 2, phase: .idle, current: "c1")))
        app.restartSession()
        #expect(restarts == 3)
        #expect(fired.contains(.restartSession))
    }

    @Test func refusalsInTheUsersWords() {
        for code in ["terminal_chat", "terminal_unsupported", "terminal_not_current", "terminal_cli_too_old", "terminal_hooks_disabled", "no_turn"] {
            let text = TerminalChatText.refusal(code: code)
            #expect(text != nil)
            #expect(EngineMessages.refusal(error: "\(code):x") == text)
        }
        #expect(TerminalChatText.refusal(code: "session_busy") == nil)
    }

    // MARK: terminal-stage2 (§57.10–57.15)

    @Test func backgroundWaitsAreRaisedOncePerKey() {
        let app = makeState()
        var raised: [AttentionEvent] = []
        app.onAttention = { raised.append($0) }
        let question = TerminalWaiting(kind: .question, message: "Which file?", since: "2026-11-20T10:00:00Z")
        let bg = [BackgroundTerminalInfo(chatId: "t1", running: true, hooksSeen: true, waiting: question),
                  BackgroundTerminalInfo(chatId: "t2", running: true, hooksSeen: true)]
        app.handle(.state(snapshot(seq: 1, phase: .idle, current: "c1", background: bg)))
        app.handle(.state(snapshot(seq: 2, phase: .idle, current: "c1", background: bg)))
        #expect(raised.count == 1)
        #expect(raised.first?.key == "term:t1:2026-11-20T10:00:00Z")
        #expect(raised.first?.kind == .question)
        #expect(raised.first?.chatId == "t1")
        #expect(app.backgroundTerminalsWaiting.map(\.chatId) == ["t1"])
        #expect(app.backgroundTerminal(chatId: "t2")?.running == true)
        #expect(app.backgroundTerminal(chatId: "c1") == nil)
        // Another background chat starts waiting: only that one is new.
        let perm = TerminalWaiting(kind: .permission, message: "Claude needs your permission to use Bash", since: "2026-11-20T10:01:00Z")
        let both = [bg[0], BackgroundTerminalInfo(chatId: "t2", running: true, hooksSeen: true, waiting: perm)]
        app.handle(.state(snapshot(seq: 3, phase: .idle, current: "c1", background: both)))
        #expect(raised.map(\.key) == ["term:t1:2026-11-20T10:00:00Z", "term:t2:2026-11-20T10:01:00Z"])
        // Back to t1 (current again, the engine keeps the same wait): the key is the same, nothing new.
        app.handle(.state(snapshot(seq: 4, phase: .idle, current: "t1",
                                   terminal: TerminalSessionInfo(running: true, hooksSeen: true, waiting: question), background: [both[1]])))
        #expect(raised.count == 2)
        #expect(app.backgroundTerminalsWaiting.map(\.chatId) == ["t2"])
    }

    @Test func aBridgedPermissionIsRaisedOnceUnderItsOwnKey() {
        let app = makeState()
        var raised: [AttentionEvent] = []
        app.onAttention = { raised.append($0) }
        let waiting = TerminalWaiting(kind: .permission, message: "Claude needs your permission to use Bash", since: "2026-11-20T10:00:00Z")
        let p1 = TerminalPermission(requestId: "r1", toolName: "Bash", summary: "Bash: git push",
                                    reason: "ReviewGate: this git command changes the repository", since: "2026-11-20T10:00:00Z")
        let info = TerminalSessionInfo(running: true, hooksSeen: true, waiting: waiting, permissions: [p1])
        app.handle(.state(snapshot(seq: 1, phase: .running, terminal: info)))
        app.handle(.state(snapshot(seq: 2, phase: .running, terminal: info)))
        #expect(raised.map(\.key) == ["termperm:t1:r1"])
        #expect(raised.first?.kind == .permission)
        #expect(raised.first?.requestId == "r1")
        #expect(raised.first?.body == "Bash: git push — ReviewGate: this git command changes the repository")
        #expect(app.terminalPermissions == [p1])
        // A second dialog: its own key; the wait is still not raised as `term:`.
        let p2 = TerminalPermission(requestId: "r2", toolName: "WebFetch", summary: "", since: "2026-11-20T10:00:05Z")
        app.handle(.state(snapshot(seq: 3, phase: .running,
                                   terminal: TerminalSessionInfo(running: true, hooksSeen: true, waiting: waiting, permissions: [p1, p2]))))
        #expect(raised.map(\.key) == ["termperm:t1:r1", "termperm:t1:r2"])
        #expect(raised.last?.body == "WebFetch")
        // The bridge is off (no entries): the plain wait is raised.
        app.handle(.state(snapshot(seq: 4, phase: .running, terminal: TerminalSessionInfo(running: true, hooksSeen: true, waiting: waiting))))
        #expect(raised.last?.key == "term:t1:2026-11-20T10:00:00Z")
        #expect(raised.count == 3)
    }

    @Test func aTerminalPermissionNotificationOffersAllowAndDeny() {
        let p = TerminalPermission(requestId: "r1", toolName: "Bash", summary: "Bash: ls", since: "t")
        #expect(AttentionEvent.terminalPermission(p, chatId: "t1").isTerminalPermission)
        let wait = TerminalWaiting(kind: .permission, message: "m", since: "t")
        #expect(!AttentionEvent.terminalWaiting(wait, chatId: "t1").isTerminalPermission)
        #expect(TerminalPermissionNotification.answer(actionIdentifier: TerminalPermissionNotification.allowAction) == true)
        #expect(TerminalPermissionNotification.answer(actionIdentifier: TerminalPermissionNotification.denyAction) == false)
        #expect(TerminalPermissionNotification.answer(actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier") == nil)
    }

    @Test func answersGoThroughTheCommandSink() {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.terminalPermissionResponse(requestId: "r1", allow: true)
        app.terminalPermissionResponse(requestId: "r2", allow: false, message: "Not now")
        app.terminalPermissionResponse(requestId: "r3", allow: true, follow: true)
        app.terminalRequestCancel()
        #expect(fired == [
            .terminalPermissionResponse(sessionId: "t1", requestId: "r1", allow: true, message: nil, follow: false),
            .terminalPermissionResponse(sessionId: "t1", requestId: "r2", allow: false, message: "Not now", follow: false),
            .terminalPermissionResponse(sessionId: "t1", requestId: "r3", allow: true, message: nil, follow: true),
            .terminalRequestCancel(sessionId: "t1"),
        ])
        // Not a terminal chat: nothing.
        app.handle(.state(snapshot(seq: 2, phase: .running, current: "c1")))
        app.terminalPermissionResponse(requestId: "r1", allow: true)
        app.terminalRequestCancel()
        #expect(fired.count == 4)
    }

    @Test func aStaleAnswerIsNoErrorRow() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.requestSink = { _ in throw EngineClientError.refused("permission_gone:", code: "permission_gone") }
        app.terminalPermissionResponse(requestId: "r1", allow: true)
        await settle()
        #expect(app.lastError == nil)
        app.requestSink = { _ in throw EngineClientError.refused("no_request_queued:", code: "no_request_queued") }
        app.terminalRequestCancel()
        await settle()
        #expect(app.lastError == nil)
    }

    @Test func requestChangesReachesALiveTerminalChat() {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .reviewing, canRequestChanges: true)))
        #expect(app.isTerminalChat)
        #expect(app.canRequestChanges)
        app.requestChanges(extraMessage: "also the tests")
        #expect(fired == [.requestChanges(extra: "also the tests", noteIds: nil)])
        #expect(TerminalStage2Text.requestChangesPrompt == "Please make the changes requested in the review notes.")
    }

    @Test func requestChangesReachesARunningTerminalTurn() {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        var s = snapshot(seq: 1, phase: .running, terminal: TerminalSessionInfo(running: true, hooksSeen: true, promptId: "p1"))
        s.reviewNotes = [ReviewNote(id: "n1", path: "notes.txt", line: 1, side: .new, excerpt: "", body: "Use a list")]
        app.handle(.state(s))
        // The gate refuses while a turn runs; a terminal turn stages it for its Stop.
        #expect(!app.state.gate.canRequestChanges)
        #expect(app.canRequestChanges)
        app.requestChanges(extraMessage: nil)
        #expect(fired == [.requestChanges(extra: nil, noteIds: nil)])
        // A turn Claude started itself (no prompt id) takes it too; a PTY that is not running, or no notes: not here.
        var own = snapshot(seq: 2, phase: .running, terminal: TerminalSessionInfo(running: true, hooksSeen: true))
        own.reviewNotes = s.reviewNotes
        app.handle(.state(own))
        #expect(app.canRequestChanges)
        var exited = snapshot(seq: 3, phase: .running, terminal: TerminalSessionInfo(running: false, hooksSeen: true, promptId: "p1"))
        exited.reviewNotes = s.reviewNotes
        app.handle(.state(exited))
        #expect(!app.canRequestChanges)
        app.handle(.state(snapshot(seq: 4, phase: .running, terminal: TerminalSessionInfo(running: true, hooksSeen: true, promptId: "p1"))))
        #expect(!app.canRequestChanges)
        // A chat-kind chat: only the gate decides.
        var chat = snapshot(seq: 5, phase: .running, current: "c1")
        chat.reviewNotes = s.reviewNotes
        app.handle(.state(chat))
        #expect(!app.canRequestChanges)
    }

    @Test func thePermissionBridgeSettingDefaultsOn() {
        let defaults = UserDefaults(suiteName: "TerminalChatStateTests.\(UUID().uuidString)")!
        #expect(AppSettings.terminalPermissionBridge(defaults: defaults))
        #expect(AppSettings.engineSettings(defaults: defaults).terminalPermissionBridge == true)
        defaults.set(false, forKey: AppSettings.Key.terminalPermissionBridge)
        #expect(!AppSettings.terminalPermissionBridge(defaults: defaults))
        #expect(AppSettings.engineSettings(defaults: defaults).terminalPermissionBridge == false)

        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.pushTerminalPermissionBridge()
        var expected = EngineSettings()
        expected.terminalPermissionBridge = false
        #expect(fired == [.setSettings(expected)])
    }

    @Test func stage2RefusalsInTheUsersWords() {
        for code in ["permission_gone", "no_request_queued", "follow_not_allowed", "chat_is_record"] {
            #expect(TerminalChatText.refusal(code: code) != nil)
            #expect(EngineMessages.refusal(error: "\(code):x") == TerminalChatText.refusal(code: code))
        }
    }
}
