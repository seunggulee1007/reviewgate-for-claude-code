import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §58: "Accept N & Continue" in a terminal chat — on only while Claude Code is idle at its prompt; the
/// click accepts the pending files (and waits for the engine), then pastes `Continue.` and presses Enter in the TUI.
@Suite @MainActor struct TerminalAcceptContinueTests {
    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "TerminalAcceptContinueTests.\(UUID().uuidString)")!)
    }

    private func file(_ path: String, _ state: FileReviewState = .pending) -> ChangedFile {
        ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: state)
    }

    private func snapshot(seq: Int, phase: GatePhase = .reviewing, files: [ChangedFile], terminal: TerminalSessionInfo? = nil,
                          current: String = "t1") -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        let idle = phase == .reviewing || phase == .idle
        s.session = SessionInfo(open: true, starting: false, sessionId: current, model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.session.terminal = terminal ?? TerminalSessionInfo(running: true, hooksSeen: true)
        s.gate = GateInfo(phase: phase, canSend: idle, canRequestChanges: false, blockedReason: idle ? nil : (phase == .collecting ? .collecting : .running),
                          collectError: nil, pendingCount: files.filter { $0.state == .pending }.count,
                          changesRequestedCount: files.filter { $0.state == .changesRequested }.count, isRequestingChanges: false,
                          turnStartTree: "a", turnEndTree: "b", lastReviewSummary: nil)
        s.changedFiles = files
        var term = SessionMeta(id: "t1", title: "In the terminal")
        term.kind = .terminal
        s.sessions = SessionsInfo(list: [term, SessionMeta(id: "c1", title: "Chat")], currentId: current, openTabIds: ["t1", "c1"])
        return s
    }

    @Test func offeredOnlyWhileTheTUIIsIdleAtItsPrompt() {
        let app = makeStore()
        app.handle(.state(snapshot(seq: 1, files: [file("a.txt"), file("b.txt", .accepted)])))
        #expect(app.terminalAcceptContinueBlocker == nil)
        // A turn runs (the gate, or a prompt the engine adopted): off, with the reason.
        app.handle(.state(snapshot(seq: 2, phase: .running, files: [file("a.txt")])))
        #expect(app.terminalAcceptContinueBlocker == TerminalFrictionText.turnRunning)
        app.handle(.state(snapshot(seq: 3, files: [file("a.txt")], terminal: TerminalSessionInfo(running: true, hooksSeen: true, promptId: "p1"))))
        #expect(app.terminalAcceptContinueBlocker == TerminalFrictionText.turnRunning)
        // Claude Code waits in its TUI (a permission dialog, a question).
        let waiting = TerminalWaiting(kind: .permission, message: "Bash", since: "2026-11-23T10:00:00.000Z")
        app.handle(.state(snapshot(seq: 4, files: [file("a.txt")], terminal: TerminalSessionInfo(running: true, hooksSeen: true, waiting: waiting))))
        #expect(app.terminalAcceptContinueBlocker == TerminalFrictionText.waitsInTerminal)
        // The changes are being collected.
        app.handle(.state(snapshot(seq: 5, phase: .collecting, files: [file("a.txt")])))
        #expect(app.terminalAcceptContinueBlocker == app.cannotSendReason)
        #expect(app.terminalAcceptContinueBlocker != nil)
        // A file sent back for changes goes through Request changes; nothing pending: nothing to accept.
        app.handle(.state(snapshot(seq: 6, files: [file("a.txt"), file("c.txt", .changesRequested)])))
        #expect(app.terminalAcceptContinueBlocker?.contains("1") == true)
        app.handle(.state(snapshot(seq: 7, files: [file("a.txt", .accepted)])))
        #expect(app.terminalAcceptContinueBlocker == TerminalFrictionText.nothingPending)
        // A chat-kind chat has its own (the message box's); the classic rule stays off in a terminal chat.
        app.handle(.state(snapshot(seq: 8, files: [file("a.txt")], current: "c1")))
        #expect(app.terminalAcceptContinueBlocker == NewChatKindText.notTerminal)
        app.handle(.state(snapshot(seq: 9, files: [file("a.txt")])))
        #expect(!app.canAcceptAndContinue)
    }

    @Test func acceptsThenPastesContinueAndPressesEnter() async {
        let app = makeStore()
        var order: [String] = []
        app.requestSink = { command in
            #expect(command == .acceptAll)
            order.append("accept_all")
        }
        app.terminalInputBlocker = { nil }
        app.onTerminalSubmit = { text in order.append("submit:\(text)"); return nil }
        app.handle(.state(snapshot(seq: 1, files: [file("a.txt"), file("b.txt")])))
        #expect(await app.terminalAcceptAndContinue() == nil)
        // The accept first (the engine puts "[Review gate] Accepted: …" in the prompt's additionalContext), then the text.
        #expect(order == ["accept_all", "submit:\(AcceptContinueRules.message)"])
    }

    @Test func nothingIsAcceptedWhenTheTerminalCannotTakeIt() async {
        let app = makeStore()
        var commands: [EngineCommand] = []
        app.requestSink = { commands.append($0) }
        var submitted: [String] = []
        app.handle(.state(snapshot(seq: 1, files: [file("a.txt")])))
        // The App has not wired the terminal (not running).
        #expect(await app.terminalAcceptAndContinue() == NewChatKindText.terminalNotRunning)
        // No bracketed paste yet (Claude Code's prompt is not up).
        app.onTerminalSubmit = { submitted.append($0); return nil }
        app.terminalInputBlocker = { NewChatKindText.terminalNotReady }
        #expect(await app.terminalAcceptAndContinue() == NewChatKindText.terminalNotReady)
        // A turn running: refused before anything.
        app.terminalInputBlocker = { nil }
        app.handle(.state(snapshot(seq: 2, phase: .running, files: [file("a.txt")])))
        #expect(await app.terminalAcceptAndContinue() == TerminalFrictionText.turnRunning)
        #expect(commands.isEmpty && submitted.isEmpty)
        // The engine refused the accept: nothing typed, its reason returned.
        app.handle(.state(snapshot(seq: 3, files: [file("a.txt")])))
        app.requestSink = { _ in throw EngineClientError.refused("reverting", code: "reverting") }
        #expect(await app.terminalAcceptAndContinue() != nil)
        #expect(submitted.isEmpty)
    }
}
