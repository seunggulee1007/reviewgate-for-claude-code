import Foundation
import Testing
@testable import ReviewGateCore

/// r2-chats-cards M31 / M33 — docs/PROTOCOL.md §9: a new chat or a switch asked for while Claude works is held, not
/// refused, and goes out once the live chat is done (its turn ended and its queue went out); a message sent from another
/// chat shown read-only goes there right after the switch; only a failed collection refuses.
@Suite @MainActor struct PendingChatSwitchTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "PendingChatSwitchTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase, current: String = "s1", collectError: String? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: current, model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        let idle = phase == .idle
        s.gate = GateInfo(phase: phase, canSend: idle, canRequestChanges: false, blockedReason: idle ? nil : .running,
                          collectError: collectError, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil, changedOutside: [], ignoredTouched: [],
                          filteredByPattern: [], restored: false)
        s.sessions = SessionsInfo(list: [SessionMeta(id: "s1", title: "Mapper fix"), SessionMeta(id: "s2", title: "Yesterday")],
                                  currentId: current, openTabIds: ["s1", "s2"])
        return s
    }

    private let page = TranscriptPageReply(sessionId: "s2", items: [TranscriptItem(at: "t5", turn: 3, kind: .userMessage(text: "what changed?"))],
                                           start: 0, before: 1)

    /// Lets the held switch's task run.
    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    private func sent(_ fired: [EngineCommand], _ text: String) -> Bool {
        fired.contains { command in
            switch command {
            case let .send(t, _, _, _): t == text
            case let .sendWithModel(t, _, _, _, _): t == text
            default: false
            }
        }
    }

    private func opens(_ fired: [EngineCommand]) -> Int {
        fired.filter { if case .sessionOpen = $0 { return true }; if case .sessionNew = $0 { return true }; return false }.count
    }

    @Test func aNewChatWhileClaudeWorksWaitsForTheTurn() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        #expect(app.newChatBlocker == nil && app.chatSwitchWaits)
        #expect(await app.newChat())
        #expect(app.pendingChatSwitch == .newChat)
        #expect(app.pendingChatSwitchText == String(localized: "A new chat opens once Claude is done in '\("Mapper fix")'", bundle: .module))
        #expect(opens(fired) == 0)

        app.handle(.state(snapshot(seq: 2, phase: .collecting)))
        await settle()
        #expect(opens(fired) == 0)
        app.handle(.state(snapshot(seq: 3, phase: .idle)))
        await settle()
        #expect(fired.last == .sessionNew)
        #expect(app.pendingChatSwitch == nil)
    }

    @Test func theLiveChatsQueueGoesFirst() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("then run the tests")
        #expect(await app.newChat())
        app.handle(.state(snapshot(seq: 2, phase: .idle)))
        await settle()
        // The queued message went to the chat it was typed in; the new chat waits for that turn.
        #expect(sent(fired, "then run the tests"))
        #expect(opens(fired) == 0 && app.pendingChatSwitch == .newChat)
        app.handle(.state(snapshot(seq: 3, phase: .running)))
        app.handle(.state(snapshot(seq: 4, phase: .idle)))
        await settle()
        #expect(fired.last == .sessionNew)
    }

    @Test func aMessageFromAnotherChatGoesThereAfterTheTurn() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.replySink = { _ in .transcriptPage(self.page) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        await app.viewChat(id: "s2")
        #expect(await app.sendInViewedChat("go on here"))
        #expect(app.pendingChatSwitchText == String(localized: "Your message goes to '\("Yesterday")' once Claude is done in '\("Mapper fix")'", bundle: .module))
        app.handle(.state(snapshot(seq: 2, phase: .idle)))
        await settle()
        #expect(fired.contains(.sessionOpen(id: "s2")))
        // The switch landed: the message joins the queue of the chat it was written in and goes out by its rules.
        app.handle(.state(snapshot(seq: 3, phase: .idle, current: "s2")))
        await settle()
        #expect(sent(fired, "go on here"))
        #expect(app.pendingChatSwitch == nil)
    }

    @Test func cancellingHandsTheMessageBack() async {
        let app = makeState()
        app.commandSink = { _ in }
        app.replySink = { _ in .transcriptPage(self.page) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        await app.viewChat(id: "s2")
        let shot = ComposerImage(mediaType: .png, data: Data([0x89, 0x50, 0x4E, 0x47]), name: "clipboard.png")
        #expect(await app.sendInViewedChat("never mind", mentions: ["src/cart.ts"], images: [shot]))
        app.cancelPendingChatSwitch()
        #expect(app.pendingChatSwitch == nil)
        // The whole message comes back — its mentions and images too, nothing of it lost.
        #expect(app.taskForComposer?.text == "never mind")
        #expect(app.taskForComposer?.mentions == ["src/cart.ts"])
        #expect(app.taskForComposer?.images == [shot])

        // [이 채팅으로 이어가기] while Claude works is held too, without a message.
        #expect(await app.continueInViewedChat())
        #expect(app.pendingChatSwitch == .openChat(id: "s2", messages: []))
        #expect(app.pendingChatSwitchText == String(localized: "Continues in '\("Yesterday")' once Claude is done in '\("Mapper fix")'", bundle: .module))
    }

    @Test func messagesHeldForOneChatAddUpAndGoOutInOrder() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.replySink = { _ in .transcriptPage(self.page) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        await app.viewChat(id: "s2")
        #expect(await app.sendInViewedChat("first"))
        #expect(await app.sendInViewedChat("then this"))
        // [이 채팅으로 이어가기] to the same chat keeps what is held for it.
        #expect(await app.continueInViewedChat())
        if case let .openChat(id, messages)? = app.pendingChatSwitch {
            #expect(id == "s2" && messages.map(\.text) == ["first", "then this"])
        } else {
            Issue.record("not held")
        }
        app.handle(.state(snapshot(seq: 2, phase: .idle)))
        await settle()
        #expect(fired.contains(.sessionOpen(id: "s2")))
        app.handle(.state(snapshot(seq: 3, phase: .idle, current: "s2")))
        await settle()
        // Both join the chat's queue in order: the first goes out, the next waits for its turn as a queued message does.
        #expect(sent(fired, "first") && !sent(fired, "then this"))
        #expect(app.queuedMessages.map(\.text) == ["then this"])
    }

    @Test func aSwitchElsewhereGivesEveryHeldMessageBack() async {
        let app = makeState()
        app.commandSink = { _ in }
        app.replySink = { _ in .transcriptPage(self.page) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        await app.viewChat(id: "s2")
        #expect(await app.sendInViewedChat("first", mentions: ["src/cart.ts"]))
        #expect(await app.sendInViewedChat("then this", mentions: ["src/pricing.ts"]))
        #expect(await app.newChat())   // the last one wins — what was held for 'Yesterday' goes back to the composer
        #expect(app.pendingChatSwitch == .newChat)
        #expect(app.taskForComposer?.text == "first\n\nthen this")
        #expect(app.taskForComposer?.mentions == ["src/cart.ts", "src/pricing.ts"])
    }

    @Test func aFailedCollectionRefusesAndDropsAHeldSwitch() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        #expect(await app.newChat())
        app.handle(.state(snapshot(seq: 2, phase: .collectFailed, collectError: "git add -A failed")))
        await settle()
        #expect(app.pendingChatSwitch == nil && opens(fired) == 0)
        #expect(app.newChatBlocker == AppState.sessionRefusalText("collect_failed"))
        // ⌘T now is never held: the engine answers it (collect_failed) and the button says why beforehand.
        _ = await app.newChat()
        #expect(app.pendingChatSwitch == nil)
    }
}
