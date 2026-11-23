import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §9 "New Chat in a Workbench": the branch it suggests, and a held message moving to the new workbench's
/// composer — taken once by the window of that folder, never sent, nothing of it lost.
@Suite @MainActor struct WorkbenchChatTests {
    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    /// 2026-11-23 09:05 UTC.
    private let now = Date(timeIntervalSince1970: 1_795_424_700)

    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "WorkbenchChatTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase, vcs: ProjectVcs? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        if let vcs { s.project?.vcs = vcs }
        s.session = SessionInfo(open: true, starting: false, sessionId: "s1", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        let idle = phase == .idle
        s.gate = GateInfo(phase: phase, canSend: idle, canRequestChanges: false, blockedReason: idle ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil, changedOutside: [], ignoredTouched: [],
                          filteredByPattern: [], restored: false)
        s.sessions = SessionsInfo(list: [SessionMeta(id: "s1", title: "Mapper fix"), SessionMeta(id: "s2", title: "Yesterday")],
                                  currentId: "s1", openTabIds: ["s1", "s2"])
        return s
    }

    private let page = TranscriptPageReply(sessionId: "s2", items: [TranscriptItem(at: "t5", turn: 3, kind: .userMessage(text: "what changed?"))],
                                           start: 0, before: 1)

    // MARK: The branch

    @Test func theBranchIsTheDateAndTimeUnderWb() {
        #expect(WorkbenchChatBranch.suggest(now: now, calendar: utc, existing: []) == "wb/261123-0905")
        #expect(WorkbenchChatBranch.suggest(now: now, calendar: utc, existing: ["main", "wb/261123-0904"]) == "wb/261123-0905")
    }

    @Test func aTakenNameGetsTheNextNumber() {
        #expect(WorkbenchChatBranch.suggest(now: now, calendar: utc, existing: ["wb/261123-0905"]) == "wb/261123-0905-2")
        #expect(WorkbenchChatBranch.suggest(now: now, calendar: utc, existing: ["wb/261123-0905", "wb/261123-0905-2", "wb/261123-0905-3"])
            == "wb/261123-0905-4")
    }

    @Test func theSuggestionIsAValidBranchName() {
        let name = WorkbenchChatBranch.suggest(now: now, calendar: utc, existing: [])
        #expect(name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "/-".contains($0)) })
        #expect(!name.hasSuffix("/") && !name.contains("//"))
    }

    // MARK: Where it is offered

    @Test func aFolderWithoutGitHasNoWorkbenchChat() {
        let app = makeState()
        #expect(app.workbenchChatBlocker == EngineMessages.refusal(error: "no_project"))
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        #expect(app.workbenchChatBlocker == nil)
        app.handle(.state(snapshot(seq: 2, phase: .idle, vcs: .shadow)))
        #expect(app.workbenchChatBlocker == String(localized: "Workbenches need a git repository — this folder is tracked without git", bundle: .module))
    }

    // MARK: The held message

    @Test func aHeldMessageMovesToTheWorkbenchAndIsNotSent() async {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.replySink = { _ in .transcriptPage(self.page) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        await app.viewChat(id: "s2")
        let shot = ComposerImage(mediaType: .png, data: Data([0x89, 0x50, 0x4E, 0x47]), name: "clipboard.png")
        #expect(await app.sendInViewedChat("first", mentions: ["src/cart.ts"], images: [shot]))
        #expect(await app.sendInViewedChat("then this"))
        #expect(app.heldMessagesForWorkbench?.text == "first\n\nthen this")

        let handoff = WorkbenchComposerHandoff()
        let folder = URL(fileURLWithPath: "/work/acme-wb/wb-261123-0905")
        #expect(app.handHeldSwitchToWorkbench(folder, handoff: handoff, now: now))
        // Called off here — not given back to this composer, and nothing waits for the turn any more.
        #expect(app.pendingChatSwitch == nil)
        #expect(app.taskForComposer == nil)
        app.handle(.state(snapshot(seq: 2, phase: .idle)))
        for _ in 0..<20 { await Task.yield() }
        #expect(!fired.contains(.sessionOpen(id: "s2")))
        #expect(!fired.contains { if case .send = $0 { return true }; if case .sendWithModel = $0 { return true }; return false })

        // The workbench's window (another AppState) takes it into its composer — whole, once.
        #expect(handoff.waits(for: folder, now: now))
        let window = makeState()
        #expect(window.takeWorkbenchHandoff(for: URL(fileURLWithPath: "/work/acme-wb/wb-261123-0905/"), handoff: handoff, now: now))
        #expect(window.taskForComposer?.text == "first\n\nthen this")
        #expect(window.taskForComposer?.mentions == ["src/cart.ts"])
        #expect(window.taskForComposer?.images == [shot])
        #expect(!handoff.waits(for: folder, now: now))
        #expect(!window.takeWorkbenchHandoff(for: folder, handoff: handoff, now: now))
    }

    @Test func aHeldNewChatIsCalledOffWithNothingToHand() async {
        let app = makeState()
        app.commandSink = { _ in }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        #expect(await app.newClassicChat())
        #expect(app.heldMessagesForWorkbench == nil)
        let handoff = WorkbenchComposerHandoff()
        let folder = URL(fileURLWithPath: "/work/acme-wb/wb-1")
        #expect(!app.handHeldSwitchToWorkbench(folder, handoff: handoff, now: now))
        #expect(app.pendingChatSwitch == nil)
        #expect(!handoff.waits(for: folder, now: now))
        // Nothing held at all: nothing changes.
        #expect(!app.handHeldSwitchToWorkbench(folder, handoff: handoff, now: now))
    }

    @Test func aHandoffWaitsAQuarterOfAnHourForItsOwnFolder() {
        let handoff = WorkbenchComposerHandoff()
        let folder = URL(fileURLWithPath: "/work/acme-wb/wb-1")
        handoff.remember(TaskComposerText(text: "go on"), for: folder, now: now)
        #expect(handoff.take(for: URL(fileURLWithPath: "/work/acme-wb/wb-2"), now: now) == nil)
        #expect(handoff.waits(for: folder, now: now.addingTimeInterval(WorkbenchComposerHandoff.lifetime)))
        #expect(!handoff.waits(for: folder, now: now.addingTimeInterval(WorkbenchComposerHandoff.lifetime + 1)))
        #expect(handoff.take(for: folder, now: now.addingTimeInterval(WorkbenchComposerHandoff.lifetime + 1)) == nil)
        // The newer message for the same folder replaces the older one; at most 20 folders wait.
        handoff.remember(TaskComposerText(text: "old"), for: folder, now: now)
        handoff.remember(TaskComposerText(text: "new"), for: folder, now: now)
        #expect(handoff.take(for: folder, now: now)?.text == "new")
        for i in 0..<25 { handoff.remember(TaskComposerText(text: "\(i)"), for: URL(fileURLWithPath: "/work/wb-\(i)"), now: now) }
        #expect(!handoff.waits(for: URL(fileURLWithPath: "/work/wb-0"), now: now))
        #expect(handoff.take(for: URL(fileURLWithPath: "/work/wb-24"), now: now)?.text == "24")
    }

    @Test func theWorkbenchsFirstChatIsAChatWhenAMessageWaits() {
        let app = makeState()
        let folder = URL(fileURLWithPath: "/work/acme-wb/wb-\(UUID().uuidString)")
        #expect(app.projectSessionSettings(for: folder).newChatKind == nil)
        WorkbenchComposerHandoff.shared.remember(TaskComposerText(text: "go on"), for: folder)
        #expect(app.projectSessionSettings(for: folder).newChatKind == .chat)
        #expect(app.takeWorkbenchHandoff(for: folder))
        #expect(app.projectSessionSettings(for: folder).newChatKind == nil)
    }
}
