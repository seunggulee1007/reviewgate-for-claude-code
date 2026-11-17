import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §57.9 on the Mac: "Continue as Terminal Chat" — the wire (`session_continue_terminal`, `continuedFrom`
/// / `continuedIn`), when it is offered and why not, and the record's link. Engine: engine.terminalChat.test.ts.
@Suite @MainActor struct ContinueTerminalTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ContinueTerminalTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase = .idle, metas: [SessionMeta], current: String, pending: Bool = false) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: current, model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        let idle = phase == .idle
        s.gate = GateInfo(phase: phase, canSend: idle, canRequestChanges: false, blockedReason: idle ? nil : .running,
                          collectError: nil, pendingCount: pending ? 1 : 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil, changedOutside: [], ignoredTouched: [],
                          filteredByPattern: [], restored: false)
        if pending {
            s.changedFiles = [ChangedFile(path: "a.txt", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: .pending)]
        }
        s.sessions = SessionsInfo(list: metas, currentId: current, openTabIds: metas.map(\.id))
        return s
    }

    private func chat(_ id: String, turns: Int = 2) -> SessionMeta {
        var m = SessionMeta(id: id, title: "Fix the cart", turns: turns)
        m.cliKnown = turns > 0
        return m
    }

    @Test func theWire() throws {
        let data = try JSONEncoder().encode(EngineCommandEnvelope(id: "c1", command: .sessionContinueTerminal(sessionId: "s1")))
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["type"] as? String == "session_continue_terminal")
        #expect(json["sessionId"] as? String == "s1")
        let meta = try JSONDecoder().decode(SessionMeta.self, from: Data(#"{"id":"t1","title":"x","kind":"terminal","cliSessionId":"s1","continuedFrom":"s1"}"#.utf8))
        #expect(meta.continuedFrom == "s1" && meta.continuedIn == nil && meta.cliSessionId == "s1")
        let src = try JSONDecoder().decode(SessionMeta.self, from: Data(#"{"id":"s1","title":"x","continuedIn":"t1"}"#.utf8))
        #expect(src.continuedIn == "t1")
        #expect(try JSONDecoder().decode(SessionMeta.self, from: JSONEncoder().encode(src)) == src)
        #expect(try JSONDecoder().decode(SessionMeta.self, from: Data(#"{"id":"s1","title":"x","continuedIn":""}"#.utf8)).continuedIn == nil)
    }

    @Test func offeredOnlyWhenItCanCarryAConversationOn() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        var term = SessionMeta(id: "t0", title: "terminal")
        term.kind = .terminal
        let fresh = chat("c0", turns: 0)
        let done = chat("c1")
        app.handle(.state(snapshot(seq: 1, metas: [done, fresh, term], current: "c1")))
        #expect(app.continueAsTerminalBlocker(done) == nil)
        #expect(app.continueAsTerminalBlocker(term) == ContinueTerminalText.refusal("not_a_chat"))
        #expect(app.continueAsTerminalBlocker(fresh) == ContinueTerminalText.refusal("nothing_to_continue"))
        #expect(MenuState(app).continueTerminalChatId == "c1" && MenuState(app).continueTerminalBlocker == nil)
        // Files waiting in the review, a turn running: off, with the reason.
        app.handle(.state(snapshot(seq: 2, metas: [done, fresh, term], current: "c1", pending: true)))
        #expect(app.continueAsTerminalBlocker(done) == ContinueTerminalText.refusal("review_pending"))
        app.handle(.state(snapshot(seq: 3, phase: .running, metas: [done, fresh, term], current: "c1")))
        #expect(app.continueAsTerminalBlocker(done) == ContinueTerminalText.busy)
        // Free again: it goes out.
        app.handle(.state(snapshot(seq: 4, metas: [done, fresh, term], current: "c1")))
        #expect(await app.continueAsTerminalChat(id: "c1"))
        #expect(fired.last == .sessionContinueTerminal(sessionId: "c1"))
        // A terminal chat on screen: the Chat menu has no item.
        app.handle(.state(snapshot(seq: 5, metas: [done, fresh, term], current: "t0")))
        #expect(MenuState(app).continueTerminalChatId == nil)
    }

    @Test func theRecordNamesItsTerminalChat() {
        let app = makeState()
        var src = chat("c1")
        src.continuedIn = "t1"
        var target = SessionMeta(id: "t1", title: "Fix the cart (터미널)")
        target.kind = .terminal
        target.continuedFrom = "c1"
        app.handle(.state(snapshot(seq: 1, metas: [target, src], current: "c1")))
        #expect(app.shownChatContinuedIn?.id == "t1")
        #expect(app.continueAsTerminalBlocker(src) == ContinueTerminalText.refusal("chat_is_record"))
        app.handle(.state(snapshot(seq: 2, metas: [target, src], current: "t1")))
        #expect(app.shownChatContinuedIn == nil)
        #expect(ContinueTerminalText.refusalOrNil("nothing_to_continue") != nil)
        #expect(ContinueTerminalText.refusalOrNil("some_other_code") == nil)
    }
}
