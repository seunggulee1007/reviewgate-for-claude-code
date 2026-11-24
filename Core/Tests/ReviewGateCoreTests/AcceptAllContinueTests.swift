import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §58.1: the Changes header's "Accept All & Continue" — on per chat kind under that kind's rule, off with
/// the reason — and the review list's folded "Accepted · not committed (N)" group.
@Suite @MainActor struct AcceptAllContinueTests {
    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "AcceptAllContinueTests.\(UUID().uuidString)")!)
    }

    private func file(_ path: String, _ state: FileReviewState = .pending) -> ChangedFile {
        ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: state)
    }

    /// `current` "c1" is a chat, "t1" a terminal chat.
    private func snapshot(seq: Int, phase: GatePhase = .reviewing, files: [ChangedFile], current: String = "c1",
                          blocked: BlockedReason? = nil, terminal: TerminalSessionInfo? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        let idle = (phase == .reviewing || phase == .idle) && blocked == nil
        s.session = SessionInfo(open: true, starting: false, sessionId: current, model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        if current == "t1" { s.session.terminal = terminal ?? TerminalSessionInfo(running: true, hooksSeen: true) }
        s.gate = GateInfo(phase: phase, canSend: idle, canRequestChanges: false,
                          blockedReason: blocked ?? (idle ? nil : (phase == .collecting ? .collecting : .running)),
                          collectError: nil, pendingCount: files.filter { $0.state == .pending }.count,
                          changesRequestedCount: files.filter { $0.state == .changesRequested }.count, isRequestingChanges: false,
                          turnStartTree: "a", turnEndTree: "b", lastReviewSummary: nil)
        s.changedFiles = files
        var term = SessionMeta(id: "t1", title: "In the terminal")
        term.kind = .terminal
        s.sessions = SessionsInfo(list: [SessionMeta(id: "c1", title: "Chat"), term], currentId: current, openTabIds: ["c1", "t1"])
        return s
    }

    @Test func aChatContinuesUnderTheMessageBoxRule() {
        let app = makeStore()
        app.handle(.state(snapshot(seq: 1, files: [file("a.txt"), file("b.txt", .accepted)])))
        #expect(app.acceptAllContinueBlocker == nil)
        // Claude is working: off, with the send's reason.
        app.handle(.state(snapshot(seq: 2, phase: .running, files: [file("a.txt")])))
        #expect(app.acceptAllContinueBlocker == app.cannotSendReason)
        #expect(app.acceptAllContinueBlocker != nil)
        // A card waits for an answer.
        app.handle(.state(snapshot(seq: 3, phase: .running, files: [file("a.txt")], blocked: .awaitingPermission)))
        #expect(app.acceptAllContinueBlocker == app.cannotSendReason)
        // A file sent back for changes goes through Request changes first.
        app.handle(.state(snapshot(seq: 4, files: [file("a.txt"), file("c.txt", .changesRequested)])))
        #expect(app.acceptAllContinueBlocker?.contains("1") == true)
        // Nothing pending: nothing to accept (accepted files do not count).
        app.handle(.state(snapshot(seq: 5, files: [file("a.txt", .accepted)])))
        #expect(app.acceptAllContinueBlocker == TerminalFrictionText.nothingPending)
    }

    @Test func aTerminalChatContinuesOnlyAtItsPrompt() {
        let app = makeStore()
        app.handle(.state(snapshot(seq: 1, files: [file("a.txt")], current: "t1")))
        #expect(app.isTerminalChat)
        #expect(app.acceptAllContinueBlocker == nil)
        #expect(!app.canAcceptAndContinue)   // the message box's rule stays off: the header follows the terminal's
        app.handle(.state(snapshot(seq: 2, files: [file("a.txt")], current: "t1", terminal: TerminalSessionInfo(running: true, hooksSeen: true, promptId: "p1"))))
        #expect(app.acceptAllContinueBlocker == TerminalFrictionText.turnRunning)
        let waiting = TerminalWaiting(kind: .permission, message: "Bash", since: "2026-11-23T10:00:00.000Z")
        app.handle(.state(snapshot(seq: 3, files: [file("a.txt")], current: "t1", terminal: TerminalSessionInfo(running: true, hooksSeen: true, waiting: waiting))))
        #expect(app.acceptAllContinueBlocker == TerminalFrictionText.waitsInTerminal)
        app.handle(.state(snapshot(seq: 4, files: [file("a.txt"), file("c.txt", .changesRequested)], current: "t1")))
        #expect(app.acceptAllContinueBlocker == app.terminalAcceptContinueBlocker)
        #expect(app.acceptAllContinueBlocker != nil)
    }

    @Test func acceptedFilesFoldApartAndLeaveTheCounts() {
        let app = makeStore()
        app.handle(.state(snapshot(seq: 1, files: [file("a.txt"), file("b.txt", .accepted), file("c.txt", .rejected), file("d.txt", .accepted)])))
        #expect(app.openChangedFiles.map(\.path) == ["a.txt", "c.txt"])
        #expect(app.acceptedChangedFiles.map(\.path) == ["b.txt", "d.txt"])
        app.viewedContent["b.txt"] = ViewedKey.content(file("b.txt", .accepted))
        app.viewedContent["a.txt"] = ViewedKey.content(file("a.txt"))
        #expect(app.viewedChangedCount == 2)
        #expect(app.viewedOpenCount == 1)   // the accepted one is out of "1/2 viewed"

        let split = AcceptedGroup.split(ChangedFileSection.build(app.changedFiles, riskOrder: false))
        #expect(split.open.flatMap(\.files).map(\.path) == ["a.txt", "c.txt"])
        #expect(split.accepted.map(\.path) == ["b.txt", "d.txt"])
        #expect(AcceptedGroup.title(2).contains("2"))

        // A file that is pending again (undo, or changed after it was accepted) is back in the open part.
        app.handle(.state(snapshot(seq: 2, files: [file("a.txt"), file("b.txt"), file("c.txt", .rejected), file("d.txt", .accepted)])))
        #expect(app.openChangedFiles.map(\.path) == ["a.txt", "b.txt", "c.txt"])
        #expect(app.acceptedChangedFiles.map(\.path) == ["d.txt"])
    }

    @Test func aSectionWithOnlyAcceptedFilesIsNotListed() {
        var mods = file(".claude/settings.json", .accepted)
        mods.group = .mods
        let sections = ChangedFileSection.build([mods, file("a.txt")], riskOrder: false)
        #expect(sections.map(\.kind) == [.mods, .claude])
        let split = AcceptedGroup.split(sections)
        #expect(split.open.map(\.kind) == [.claude])
        #expect(split.accepted.map(\.path) == [".claude/settings.json"])
    }
}
