import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §58.1: the Changes header's primary follows the review — accept all, accept the rest, continue, request
/// changes, or nothing — for a chat and a terminal chat, and the ⋯ items' rules.
@Suite @MainActor struct ContinueStatesTests {
    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ContinueStatesTests.\(UUID().uuidString)")!)
    }

    private func file(_ path: String, _ state: FileReviewState = .pending) -> ChangedFile {
        ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: state)
    }

    private func note(_ id: String, sent: Bool = false) -> ReviewNote {
        ReviewNote(id: id, path: "a.txt", line: 1, side: .new, excerpt: "x", body: "rename",
                   sent: sent ? NoteSent(at: "2026-11-24T00:00:00Z", turn: 1) : nil)
    }

    /// `current` "c1" is a chat, "t1" a terminal chat.
    private func snapshot(seq: Int, phase: GatePhase = .reviewing, files: [ChangedFile], untold: UntoldDecisions? = nil,
                          summary: String? = nil, notes: [ReviewNote] = [], current: String = "c1",
                          terminal: TerminalSessionInfo? = nil, reviewFirst: ReviewFirstInfo? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        let idle = phase == .reviewing || phase == .idle
        s.session = SessionInfo(open: true, starting: false, sessionId: current, model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        if current == "t1" { s.session.terminal = terminal ?? TerminalSessionInfo(running: true, hooksSeen: true) }
        s.gate = GateInfo(phase: phase, canSend: idle, canRequestChanges: idle && notes.contains { $0.sent == nil },
                          blockedReason: idle ? nil : (phase == .collecting ? .collecting : .running),
                          collectError: nil, pendingCount: files.filter { $0.state == .pending }.count,
                          changesRequestedCount: files.filter { $0.state == .changesRequested }.count, isRequestingChanges: false,
                          turnStartTree: "a", turnEndTree: "b", lastReviewSummary: summary ?? (untold == nil ? nil : "[Review gate] …"))
        s.gate.untoldDecisions = untold
        s.gate.reviewFirst = reviewFirst
        s.changedFiles = files
        s.reviewNotes = notes
        var term = SessionMeta(id: "t1", title: "In the terminal")
        term.kind = .terminal
        s.sessions = SessionsInfo(list: [SessionMeta(id: "c1", title: "Chat"), term], currentId: current, openTabIds: ["c1", "t1"])
        return s
    }

    @Test func theDecisionTable() {
        // Pending, nothing decided: accept all.
        #expect(ContinueRules.primary(pending: 3, unsentNotes: 0, decided: false, untold: false) == .acceptAll(pending: 3))
        // Some accepted (in the list) or rejected (told by the summary only): accept the rest.
        #expect(ContinueRules.primary(pending: 2, unsentNotes: 0, decided: true, untold: false) == .acceptRest(pending: 2))
        #expect(ContinueRules.primary(pending: 2, unsentNotes: 0, decided: false, untold: true) == .acceptRest(pending: 2))
        // Nothing pending, decisions not told yet: continue.
        #expect(ContinueRules.primary(pending: 0, unsentNotes: 0, decided: true, untold: true) == .continueOnly)
        #expect(ContinueRules.primary(pending: 0, unsentNotes: 0, decided: false, untold: true) == .continueOnly)
        // Notes to send come first, whatever else.
        #expect(ContinueRules.primary(pending: 2, unsentNotes: 1, decided: true, untold: true) == .requestChanges(notes: 1))
        #expect(ContinueRules.primary(pending: 0, unsentNotes: 2, decided: false, untold: false) == .requestChanges(notes: 2))
        // Nothing pending, nothing new to tell: no button.
        #expect(ContinueRules.primary(pending: 0, unsentNotes: 0, decided: true, untold: false) == nil)
        #expect(ContinueRules.primary(pending: 0, unsentNotes: 0, decided: false, untold: false) == nil)
    }

    @Test func aChatFollowsTheReview() {
        let app = makeStore()
        app.handle(.state(snapshot(seq: 1, files: [file("a.txt"), file("b.txt")])))
        #expect(app.continuePrimary == .acceptAll(pending: 2))
        #expect(ContinueText.title(app.continuePrimary!) == AcceptAllContinueText.title)
        #expect(app.continuePrimaryBlocker == nil)

        // One accepted: the rest.
        app.handle(.state(snapshot(seq: 2, files: [file("a.txt", .accepted), file("b.txt")], untold: UntoldDecisions(accepted: 1, rejected: 0))))
        #expect(app.continuePrimary == .acceptRest(pending: 1))
        #expect(ContinueText.title(app.continuePrimary!).contains("1"))
        // One rejected (gone from the list): the summary still says something was decided.
        app.handle(.state(snapshot(seq: 3, files: [file("b.txt")], untold: UntoldDecisions(accepted: 0, rejected: 1))))
        #expect(app.continuePrimary == .acceptRest(pending: 1))

        // All decided one by one: continue, and it sends a plain "Continue." (nothing accepted by it).
        app.handle(.state(snapshot(seq: 4, files: [file("a.txt", .accepted)], untold: UntoldDecisions(accepted: 1, rejected: 1))))
        #expect(app.continuePrimary == .continueOnly)
        #expect(app.continuePrimaryBlocker == nil)
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        #expect(app.continueWithoutAccepting())
        #expect(sent == [.send(text: "Continue.")])

        // Told already (the summary went with the last message): nothing to do.
        app.handle(.state(snapshot(seq: 5, files: [file("a.txt", .accepted)])))
        #expect(app.continuePrimary == nil)
        #expect(app.continuePrimaryBlocker == nil)

        // An older engine without the count: its summary text says there is something to tell.
        app.handle(.state(snapshot(seq: 6, files: [], summary: "[Review gate] Rejected (reverted on disk, do not redo unless asked): b.txt.")))
        #expect(app.continuePrimary == .continueOnly)

        // Notes waiting to be sent: request changes.
        app.handle(.state(snapshot(seq: 7, files: [file("a.txt")], notes: [note("n1"), note("n2"), note("n0", sent: true)])))
        #expect(app.continuePrimary == .requestChanges(notes: 2))
        #expect(app.continuePrimaryBlocker == nil)
    }

    @Test func offWithTheReason() {
        let app = makeStore()
        // Claude working: continue is off with the send's reason.
        app.handle(.state(snapshot(seq: 1, phase: .running, files: [], untold: UntoldDecisions(accepted: 1, rejected: 0))))
        #expect(app.continuePrimary == .continueOnly)
        #expect(app.continuePrimaryBlocker == app.cannotSendReason)
        #expect(app.continuePrimaryBlocker != nil)
        #expect(!app.continueWithoutAccepting())
        // Accept the rest while collecting: the accept-all rule's reason.
        app.handle(.state(snapshot(seq: 2, phase: .collecting, files: [file("a.txt")], untold: UntoldDecisions(accepted: 1, rejected: 0))))
        #expect(app.continuePrimary == .acceptRest(pending: 1))
        #expect(app.continuePrimaryBlocker == app.acceptAllContinueBlocker)
        #expect(app.continuePrimaryBlocker != nil)
        // Notes while Claude works: Request changes waits with the reason.
        app.handle(.state(snapshot(seq: 3, phase: .running, files: [file("a.txt")], notes: [note("n1")])))
        #expect(app.continuePrimary == .requestChanges(notes: 1))
        #expect(app.continuePrimaryBlocker != nil)
    }

    @Test func aTerminalChatContinuesOnlyAtItsPrompt() {
        let app = makeStore()
        app.handle(.state(snapshot(seq: 1, files: [], untold: UntoldDecisions(accepted: 1, rejected: 1), current: "t1")))
        #expect(app.isTerminalChat)
        #expect(app.continuePrimary == .continueOnly)
        #expect(app.continuePrimaryBlocker == nil)
        // A chat's send is never used for a terminal chat.
        #expect(!app.continueWithoutAccepting())
        // A turn running in the TUI, or a dialog waiting there: off with why.
        app.handle(.state(snapshot(seq: 2, files: [], untold: UntoldDecisions(accepted: 1, rejected: 1), current: "t1",
                                   terminal: TerminalSessionInfo(running: true, hooksSeen: true, promptId: "p1"))))
        #expect(app.continuePrimaryBlocker == TerminalFrictionText.turnRunning)
        let waiting = TerminalWaiting(kind: .permission, message: "Bash", since: "2026-11-23T10:00:00.000Z")
        app.handle(.state(snapshot(seq: 3, files: [], untold: UntoldDecisions(accepted: 1, rejected: 1), current: "t1",
                                   terminal: TerminalSessionInfo(running: true, hooksSeen: true, waiting: waiting))))
        #expect(app.continuePrimaryBlocker == TerminalFrictionText.waitsInTerminal)
        // Accept the rest in a terminal chat: the terminal's accept rule.
        app.handle(.state(snapshot(seq: 4, files: [file("a.txt", .accepted), file("b.txt")], untold: UntoldDecisions(accepted: 1, rejected: 0), current: "t1")))
        #expect(app.continuePrimary == .acceptRest(pending: 1))
        #expect(app.continuePrimaryBlocker == nil)
        #expect(app.continuePrimaryBlocker == app.terminalAcceptContinueBlocker)
    }

    @Test func theMenusLeaveTheRestPendingItem() {
        let app = makeStore()
        // Nothing pending: the primary covers it.
        app.handle(.state(snapshot(seq: 1, files: [], untold: UntoldDecisions(accepted: 1, rejected: 0))))
        #expect(app.continueLeavingRestBlocker == TerminalFrictionText.nothingPending)
        // Pending: on, and it sends a plain "Continue." — the pending files stay.
        app.handle(.state(snapshot(seq: 2, files: [file("a.txt", .accepted), file("b.txt")], untold: UntoldDecisions(accepted: 1, rejected: 0))))
        #expect(app.continueLeavingRestBlocker == nil)
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        #expect(app.continueWithoutAccepting())
        #expect(sent == [.send(text: "Continue.")])
        // §64 `prompts` holds a message while files wait: off with why.
        app.handle(.state(snapshot(seq: 3, files: [file("b.txt")], reviewFirst: ReviewFirstInfo(mode: .prompts, waiting: 1))))
        #expect(app.continueLeavingRestBlocker == ContinueText.reviewFirstHolds)
        // `edits` (the default) lets it go — Claude may fix only the files under review.
        app.handle(.state(snapshot(seq: 4, files: [file("b.txt")], reviewFirst: ReviewFirstInfo(mode: .edits, waiting: 1))))
        #expect(app.continueLeavingRestBlocker == nil)
        // Claude working.
        app.handle(.state(snapshot(seq: 5, phase: .running, files: [file("b.txt")])))
        #expect(app.continueLeavingRestBlocker == app.cannotSendReason)
        // A terminal chat: its prompt rule.
        app.handle(.state(snapshot(seq: 6, files: [file("b.txt")], current: "t1",
                                   terminal: TerminalSessionInfo(running: true, hooksSeen: true, promptId: "p1"))))
        #expect(app.continueLeavingRestBlocker == TerminalFrictionText.turnRunning)
        app.handle(.state(snapshot(seq: 7, files: [file("b.txt")], current: "t1")))
        #expect(app.continueLeavingRestBlocker == nil)
    }

    @Test func aTerminalContinueTypesWithoutAccepting() async {
        let app = makeStore()
        var commands: [EngineCommand] = []
        app.requestSink = { commands.append($0) }
        var submitted: [String] = []
        app.terminalInputBlocker = { nil }
        app.onTerminalSubmit = { submitted.append($0); return nil }
        // Nothing pending, decisions to tell: "Continue." typed, nothing accepted (the summary is the prompt's context).
        app.handle(.state(snapshot(seq: 1, files: [], untold: UntoldDecisions(accepted: 1, rejected: 1), current: "t1")))
        #expect(await app.terminalContinue(accepting: false) == nil)
        #expect(commands.isEmpty)
        #expect(submitted == [AcceptContinueRules.message])
        // Leave the rest pending: the same, the pending file untouched.
        app.handle(.state(snapshot(seq: 2, files: [file("b.txt")], current: "t1")))
        #expect(await app.terminalContinue(accepting: false) == nil)
        #expect(commands.isEmpty)
        #expect(submitted.count == 2)
        // The TUI busy: nothing typed.
        app.handle(.state(snapshot(seq: 3, files: [], untold: UntoldDecisions(accepted: 1, rejected: 0), current: "t1",
                                   terminal: TerminalSessionInfo(running: true, hooksSeen: true, promptId: "p1"))))
        #expect(await app.terminalContinue(accepting: false) == TerminalFrictionText.turnRunning)
        #expect(submitted.count == 2)
    }

    @Test func untoldDecisionsDecodeLeniently() throws {
        let json = #"{"phase":"idle","canSend":true,"untoldDecisions":{"accepted":2,"rejected":1}}"#
        let gate = try JSONDecoder().decode(GateInfo.self, from: Data(json.utf8))
        #expect(gate.untoldDecisions == UntoldDecisions(accepted: 2, rejected: 1))
        let old = try JSONDecoder().decode(GateInfo.self, from: Data(#"{"phase":"idle","canSend":true}"#.utf8))
        #expect(old.untoldDecisions == nil)
        let null = try JSONDecoder().decode(GateInfo.self, from: Data(#"{"phase":"idle","untoldDecisions":null}"#.utf8))
        #expect(null.untoldDecisions == nil)
    }

    @Test func continueSaysWhatItTellsAndTheAcceptedGroupNeverCountsBelowItsRows() {
        #expect(ContinueCaption.text(nil) == nil)
        #expect(ContinueCaption.text(UntoldDecisions(accepted: 0, rejected: 0)) == nil)
        #expect(ContinueCaption.text(UntoldDecisions(accepted: 1, rejected: 2)) != nil)
        #expect(AcceptedGroup.count(summary: ReviewSummary(files: 2, added: 0, deleted: 0, acceptedUncommitted: 0), shown: 2, filtered: false) == 2)
    }
}
