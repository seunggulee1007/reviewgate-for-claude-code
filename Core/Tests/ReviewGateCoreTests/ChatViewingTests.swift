import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: wave4b w4b-tabs — docs/PROTOCOL.md §39.2 on the Mac: another chat tab is read without switching (daily-13), and a
/// run of exploration calls folds into one row (market-12).
@Suite @MainActor struct ChatViewingTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ChatViewingTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase, current: String = "s1") -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: current, model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        let idle = phase == .idle
        s.gate = GateInfo(phase: phase, canSend: idle, canRequestChanges: false, blockedReason: idle ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil, changedOutside: [], ignoredTouched: [],
                          filteredByPattern: [], restored: false)
        s.sessions = SessionsInfo(list: [SessionMeta(id: "s1", title: "Mapper fix"), SessionMeta(id: "s2", title: "Yesterday")],
                                  currentId: current, openTabIds: ["s1", "s2"])
        return s
    }

    private let page = TranscriptPageReply(sessionId: "s2", items: [TranscriptItem(at: "t5", turn: 3, kind: .userMessage(text: "what changed?")),
                                                                    TranscriptItem(at: "t6", turn: 3, kind: .assistantText(text: "the mapper"))],
                                           start: 5, before: 7)

    @Test func anotherTabShowsItsRowsAndNothingSwitches() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        var asked: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.replySink = { command in
            asked.append(command)
            return .transcriptPage(self.page)
        }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.handle(.userMessage(text: "live question", turn: 1))
        await app.viewChat(id: "s2")
        #expect(asked == [.transcriptPage(sessionId: "s2", before: ChatViewing.end, beforeAt: nil, limit: 200)])
        #expect(!fired.contains { if case .sessionOpen = $0 { return true }; return false })
        guard let shown = app.viewingChat else { Issue.record("not viewing"); return }
        #expect(shown.id == "s2" && shown.start == 5 && shown.oldestAt == "t5" && !shown.loading && shown.canLoadEarlier)
        #expect(shown.rows.count == 2)
        #expect(app.transcript.count == 1)   // the live chat keeps its rows
        #expect(app.shownChatId == "s2" && app.draftChatId == "s2")

        // Claude works in the live chat: reading is fine; a send waits until it is done (r2-chats-cards M33, §9).
        #expect(app.viewingSendBlocker == nil)
        #expect(app.viewingSendWait == String(localized: "Claude is working in '\("Mapper fix")'", bundle: .module))
        #expect(await app.sendInViewedChat("go on"))
        #expect(app.pendingChatSwitch?.chatId == "s2")
        if case let .openChat(_, messages)? = app.pendingChatSwitch { #expect(messages.map(\.text) == ["go on"]) } else { Issue.record("not held") }
        #expect(!fired.contains { if case .sessionOpen = $0 { return true }; return false })
        #expect(app.queuedMessages.isEmpty)   // never the live chat's queue

        // The running tab brings the live chat back.
        await app.viewChat(id: "s1")
        #expect(app.viewingChat == nil && app.shownChatId == "s1" && app.draftChatId == "s1")
    }

    /// wave4b integration (§39.2 × §39.3): a link to a call in the shown chat's rows (its turn summary card) is revealed
    /// there; an agent card or diff → cause (the running chat's calls) shows the running chat first.
    @Test func aRevealStaysInTheShownChatOnlyForItsOwnCalls() async {
        let app = makeState()
        let withCall = TranscriptPageReply(sessionId: "s2", items: [
            TranscriptItem(at: "t5", turn: 3, kind: .userMessage(text: "split the mapper")),
            TranscriptItem(at: "t6", turn: 3, kind: .toolUse(id: "agentB", name: "Agent", input: .object(["subagent_type": .string("executor")]), file: nil)),
        ], start: 0, before: 7)
        app.replySink = { _ in .transcriptPage(withCall) }
        app.handle(.state(snapshot(seq: 1, phase: .idle)))
        app.handle(.userMessage(text: "live question", turn: 1))
        #expect(!app.revealStaysInViewedChat(toolUseId: "agentB"))   // nothing is viewed
        await app.viewChat(id: "s2")
        #expect(app.viewingChat != nil)
        #expect(app.revealStaysInViewedChat(toolUseId: "agentB"))
        #expect(!app.revealStaysInViewedChat(toolUseId: "liveAgent"))
    }

    @Test func sendingFromAViewedChatSwitchesThenSends() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.replySink = { _ in .transcriptPage(self.page) }
        app.handle(.state(snapshot(seq: 1, phase: .idle)))
        await app.viewChat(id: "s2")
        #expect(app.viewingSendBlocker == nil)
        #expect(await app.sendInViewedChat("continue here"))
        #expect(fired.first == .sessionOpen(id: "s2"))
        #expect(fired.contains(.send(text: "continue here", acceptPending: false)) || app.queuedMessages.map(\.text) == ["continue here"])
        // The live chat became the viewed one: the view is over, the draft key stays on it.
        app.handle(.state(snapshot(seq: 2, phase: .idle, current: "s2")))
        #expect(app.viewingChat == nil && app.shownChatId == "s2" && app.draftChatId == "s2")
    }

    @Test func aQueueOrAnOldEngineKeepTheOldWays() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .idle)))
        // An engine before §38.3 cannot read another chat: the tab switches as before.
        app.replySink = { _ in throw EngineClientError.refused("unknown command: transcript_page", code: "unknown_command") }
        await app.viewChat(id: "s2")
        #expect(app.viewingChat == nil)
        #expect(fired.last == .sessionOpen(id: "s2"))

        // A failed read says so on one line.
        app.replySink = { _ in throw EngineClientError.refused("unknown_session:s2", code: "unknown_session:s2") }
        await app.viewChat(id: "s2")
        #expect(app.viewingChat?.error == String(localized: "Could not load this chat", bundle: .module))

        // Messages still waiting in the live chat's queue go first: a send from another chat waits for them.
        #expect(ChatViewing.sendWait(phase: .idle, liveTitle: "A", queued: true)
            == String(localized: "Messages are waiting in the queue of '\("A")'", bundle: .module))
        #expect(ChatViewing.sendWait(phase: .reviewing, liveTitle: "A", queued: false) == nil)
        #expect(ChatViewing.sendWait(phase: .collecting, liveTitle: "A", queued: false)
            == String(localized: "Claude is working in '\("A")'", bundle: .module))
        #expect(ChatViewing.sendWait(phase: .idle, liveTitle: "A", queued: false) == nil)
    }

    /// The tab's × and context menu, Chat › Close Chat Tab and the history's Open while a switch is refused.
    @Test func tabsCloseAndOpenReadOnlyWhileClaudeWorks() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.replySink = { _ in .transcriptPage(self.page) }
        var s = snapshot(seq: 1, phase: .running)
        s.sessions = SessionsInfo(list: [SessionMeta(id: "s1", title: "Mapper fix"), SessionMeta(id: "s2", title: "Yesterday"),
                                         SessionMeta(id: "s3", title: "Older")],
                                  currentId: "s1", openTabIds: ["s1", "s2"])
        app.handle(.state(s))
        // While Claude works the live chat's tab stays (closing it would switch); another chat's closes.
        #expect(!app.canCloseTab(id: "s1") && app.canCloseTab(id: "s2") && !app.canCloseTab(id: "s3"))
        #expect(!MenuState(app).canCloseShownTab)   // the live chat is on screen

        // The history's Open: the chat joins the tabs and is shown read-only — nothing switches.
        await app.openTabReadOnly(id: "s3")
        #expect(fired.contains(.tabsSet(openTabIds: ["s1", "s2", "s3"])))
        #expect(app.viewingChat?.id == "s3")
        #expect(!fired.contains { if case .sessionOpen = $0 { return true }; return false })

        s.seq = 2
        s.sessions?.openTabIds = ["s1", "s2", "s3"]
        app.handle(.state(s))
        #expect(MenuState(app).canCloseShownTab)
        // Close Other Tabs keeps the live chat's tab; the chat on screen goes back to the live one when its tab goes.
        app.closeOtherTabs(keeping: "s2")
        #expect(fired.last == .tabsSet(openTabIds: ["s1", "s2"]))
        #expect(app.viewingChat == nil)

        s.seq = 3
        s.sessions?.openTabIds = ["s1", "s2"]
        app.handle(.state(s))
        await app.viewChat(id: "s2")
        #expect(await app.closeChatTab(id: "s2"))
        #expect(fired.last == .tabsSet(openTabIds: ["s1"]) && app.viewingChat == nil)
        #expect(!(await app.closeChatTab(id: "s1")))   // the live chat's tab while Claude works
    }

    // MARK: market-12

    private func use(_ id: String, _ name: String, explore: Bool = true, parent: String? = nil, file: String? = nil) -> TranscriptNode {
        var info = ToolUseInfo(parentToolUseId: parent)
        info.explore = explore
        return .row(.toolUse(id: UUID(), toolUseId: id, name: name, file: file, input: .object([:]), info: info))
    }

    private func result(_ id: String, error: Bool = false) -> TranscriptNode {
        .row(.toolResult(id: UUID(), toolUseId: id, isError: error, preview: "", info: ToolResultInfo()))
    }

    private func shape(_ entries: [ExploreFold.Entry]) -> [String] {
        entries.map { entry in
            switch entry {
            case let .run(run): "run(\(run.nodes.count))"
            case let .node(.row(.toolUse(_, id, _, _, _, _))): id
            case let .node(.row(.toolResult(_, id, _, _, _))): "=\(id)"
            case .node(.row(.assistant)): "text"
            case .node: "other"
            }
        }
    }

    @Test func explorationRunsFold() throws {
        let text: TranscriptNode = .row(.assistant(id: UUID(), text: "Now the edit.", streaming: false, unprompted: false))
        let nodes: [TranscriptNode] = [
            use("r1", "Read", file: "/repo/A.java"), use("r2", "Read", file: "/repo/B.xml"), result("r1"), result("r2"),
            use("g1", "Grep"), result("g1"), use("b1", "Bash"), result("b1"),
            text,
            use("e1", "Edit", explore: false), result("e1"),
            use("r3", "Read"), result("r3"),   // one call alone stays as it is
            use("r4", "Read"), result("r4", error: true), use("r5", "Read"), result("r5"),   // a failed read is shown
        ]
        let entries = ExploreFold.fold(nodes)
        #expect(shape(entries) == ["run(8)", "text", "e1", "=e1", "r3", "=r3", "r4", "=r4", "r5", "=r5"])
        guard case let .run(run) = entries[0] else { Issue.record("no run"); return }
        #expect(run.id == nodes[0].id && run.contains(toolUseId: "g1") && !run.contains(toolUseId: "e1"))
        #expect(run.counts == ExploreCounts(files: 2, searches: 1, commands: 1, lookups: 0, open: 0))

        // A subagent's calls (inside its group) and a call still open: the open one counts, the nested one is not folded.
        let live = ExploreFold.fold([use("r1", "Read", file: "a"), use("m1", "mcp__es__search"), use("n1", "Read", parent: "agent")])
        #expect(shape(live) == ["run(2)", "n1"])
        guard case let .run(open) = live[0] else { Issue.record("no live run"); return }
        #expect(open.counts == ExploreCounts(files: 1, searches: 0, commands: 0, lookups: 1, open: 2))
        #expect(ExploreCounts(files: 12, searches: 5).summary
            == String(localized: "\(12) files read", bundle: .module) + " · " + String(localized: "\(5) searches", bundle: .module))
    }

    @Test func theExploreFlagIsReadLeniently() throws {
        let row = try JSONDecoder().decode(TranscriptItem.self, from: Data(#"{"at":"t","turn":1,"kind":"tool_use","id":"r1","name":"Read","input":{},"explore":true}"#.utf8))
        guard case let .toolUse(_, _, _, _, info) = row.kind else { Issue.record("not a tool row"); return }
        #expect(info.explore)
        let old = try JSONDecoder().decode(TranscriptItem.self, from: Data(#"{"at":"t","turn":1,"kind":"tool_use","id":"r1","name":"Read","input":{},"explore":"yes"}"#.utf8))
        guard case let .toolUse(_, _, _, _, oldInfo) = old.kind else { Issue.record("not a tool row"); return }
        #expect(!oldInfo.explore)
        let event = try NDJSON.decode(EngineEvent.self, from: #"{"type":"tool_use","id":"g1","name":"Grep","input":{"pattern":"x"},"explore":true}"#)
        guard case let .toolUse(_, _, _, _, eventInfo) = event else { Issue.record("not a tool_use: \(event)"); return }
        #expect(eventInfo.explore)
    }
}
