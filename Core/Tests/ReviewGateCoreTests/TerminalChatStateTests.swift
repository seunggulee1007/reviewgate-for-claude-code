import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §57.5 on the Mac: a terminal chat is opened like ⌘T (held while Claude works), its spec is asked for,
/// the TUI's waits become attention once each, and Stop goes to the PTY instead of the engine.
@Suite @MainActor struct TerminalChatStateTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "TerminalChatStateTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase, current: String = "t1", terminal: TerminalSessionInfo? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: current, model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.session.terminal = terminal
        let idle = phase == .idle
        s.gate = GateInfo(phase: phase, canSend: idle, canRequestChanges: false, blockedReason: idle ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil, changedOutside: [], ignoredTouched: [],
                          filteredByPattern: [], restored: false)
        var term = SessionMeta(id: "t1", title: "In the terminal")
        term.kind = .terminal
        s.sessions = SessionsInfo(list: [term, SessionMeta(id: "c1", title: "Chat")], currentId: current, openTabIds: ["t1", "c1"])
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
        let spec = TerminalSpec(sessionId: "t1", argv: ["/usr/local/bin/claude", "--session-id", "t1"], env: ["RG_HOOK_TOKEN": "x"],
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

    @Test func refusalsInTheUsersWords() {
        for code in ["terminal_chat", "terminal_unsupported", "terminal_not_current", "terminal_cli_too_old", "terminal_hooks_disabled", "no_turn"] {
            let text = TerminalChatText.refusal(code: code)
            #expect(text != nil)
            #expect(EngineMessages.refusal(error: "\(code):x") == text)
        }
        #expect(TerminalChatText.refusal(code: "session_busy") == nil)
    }
}
