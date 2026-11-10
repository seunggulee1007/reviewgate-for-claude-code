import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: r2-peers — docs/PROTOCOL.md §29 / §33.2 / §33.1 / §18 on the Mac: messages from the user's other sessions run as
/// they arrive (`auto`, the default) when the registry names their sender — a line, not a card; a SendMessage card to a
/// live session's known conversation can be remembered for the session; several waiting cards are answered at once; the
/// unprompted notice offers to continue.
@Suite @MainActor struct PeerAutoTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "PeerAutoTests.\(UUID().uuidString)")!)
    }

    private let b4 = PeerSessionInfo(address: "uds:/tmp/cc-socks/4242.sock", pid: 4242, name: "acme-b4", cwd: "/work/acme", status: .idle,
                                     entrypoint: "cli")

    private func held(_ id: String, sender: PeerSessionInfo? = nil, state: PeerMessageState = .held) -> PeerMessage {
        PeerMessage(id: id, from: "uds:/tmp/cc-socks/4242.sock", fromName: "acme-b4", cause: "explicit-setting", receivedAt: "2026-11-06T01:00:00Z",
                    state: state, sender: sender)
    }

    private func snapshot(seq: Int, inbox: [PeerMessage] = [], mode: PeerInboundMode? = .auto, queue: [PermissionRequest] = [],
                          running: Bool = false) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: queue.first,
                                canRestart: true)
        s.session.pendingPermissions = queue
        s.session.ready = true
        s.session.peerInbound = mode
        s.session.peerInbox = inbox
        s.gate = GateInfo(phase: running ? .running : .idle, canSend: !running, canRequestChanges: false,
                          blockedReason: running ? (queue.isEmpty ? .running : .awaitingPermission) : nil, collectError: nil, pendingCount: 0,
                          changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: "A", turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    // MARK: §29 — auto, the default

    @Test func theWireCarriesTheSender() throws {
        let json = #"{"id":"m1","from":"uds:/tmp/cc-socks/4242.sock","fromName":"acme-b4","verifiedPeerPid":null,"cause":"explicit-setting","receivedAt":"t","state":"held","sender":{"address":"uds:/tmp/cc-socks/4242.sock","pid":4242,"name":"acme-b4","cwd":"/work/acme","status":"idle","entrypoint":"cli"}}"#
        let m = try JSONDecoder().decode(PeerMessage.self, from: Data(json.utf8))
        #expect(m.sender == b4)
        let back = try JSONDecoder().decode(PeerMessage.self, from: JSONEncoder().encode(m))
        #expect(back == m)
        // An older engine: no sender.
        let old = try JSONDecoder().decode(PeerMessage.self, from: Data(#"{"id":"m2","from":"x","state":"held"}"#.utf8))
        #expect(old.sender == nil)
    }

    @Test func whatRunsByItselfIsALineNotACard() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, inbox: [held("m1", sender: b4)])))
        #expect(app.peerInboxRunsByItself)
        // Waiting for the current work: still nothing to decide.
        app.handle(.state(snapshot(seq: 2, inbox: [held("m1", sender: b4)], running: true)))
        #expect(app.peerInboxRunsByItself)
        app.handle(.state(snapshot(seq: 3, inbox: [held("m1", sender: b4, state: .delivering)])))
        #expect(app.peerInboxRunsByItself)
        // One the registry does not vouch for holds every message: the card.
        app.handle(.state(snapshot(seq: 4, inbox: [held("m1", sender: b4), held("m2")])))
        #expect(!app.peerInboxRunsByItself)
        // Ask (a project's own choice): the card.
        app.handle(.state(snapshot(seq: 5, inbox: [held("m1", sender: b4)], mode: .ask)))
        #expect(!app.peerInboxRunsByItself)
        app.handle(.state(snapshot(seq: 6)))
        #expect(!app.peerInboxRunsByItself)
    }

    @Test func theLineNamesTheSendersByTheRegistry() {
        var renamed = b4
        renamed.name = "acme-terminal"
        #expect(PeerText.senderNames([held("m1", sender: renamed), held("m2", sender: renamed), held("m3")]) == ["acme-terminal", "acme-b4"])
        #expect(PeerText.runsByItself(from: ["acme-b4"]).contains("acme-b4"))
    }

    @Test func autoIsTheDefaultAndTheLabelsSaySo() {
        #expect(AppSettings.peerInbound(defaults: UserDefaults(suiteName: "PeerAutoTests.\(UUID().uuidString)")!) == .auto)
        #expect(PeerInboundMode.auto.displayName == String(localized: "Handle on arrival (default)", bundle: .module))
        #expect(PeerInboundMode.ask.displayName == String(localized: "Ask first", bundle: .module))
    }

    // MARK: §33.2 — "이 세션으로 보내는 메시지는 세션 동안 허용"

    @Test func theRegistryEntryCarriesItsConversation() throws {
        let info = try JSONDecoder().decode(PeerSessionInfo.self, from: Data(#"{"address":"a","pid":1,"status":"idle","sessionId":"s-b4"}"#.utf8))
        #expect(info.sessionId == "s-b4")
        let back = try JSONDecoder().decode(PeerSessionInfo.self, from: JSONEncoder().encode(info))
        #expect(back == info)
        // An older engine: no sessionId.
        let old = try JSONDecoder().decode(PeerSessionInfo.self, from: Data(#"{"address":"a","pid":1,"status":"idle"}"#.utf8))
        #expect(old.sessionId == nil)
    }

    @Test func aSendMessageCardToAKnownConversationCanBeRemembered() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        var send = PermissionRequest(requestId: "S1", toolName: "SendMessage", input: .object(["to": .string(b4.address), "message": .string("#42 done")]))
        #expect(!PermissionCardOptions(request: send).allowsRemember)   // nobody known: send / decline only
        send.toSession = b4   // a live session without its conversation (an older registry)
        #expect(!PermissionCardOptions(request: send).allowsRemember)
        var known = b4
        known.sessionId = "s-b4"
        send.toSession = known
        let options = PermissionCardOptions(request: send)
        #expect(options.layout == .sendMessage && options.allowsRemember && !options.showsAlwaysAllow)
        #expect(CardShortcuts.action(for: .optionCommandReturn, focus: .permissionCard(requestId: "S1"), target: send) == .allowForSession(requestId: "S1"))
        var outside = send
        outside.reason = PermissionReason(code: .outsideProject, message: "outside", path: "/elsewhere")
        #expect(!PermissionCardOptions(request: outside).allowsRemember)
        app.handle(.permissionRequest(send))
        app.handle(.state(snapshot(seq: 1, queue: [send], running: true)))
        app.respondPermission(requestId: "S1", allow: true, remember: true)
        #expect(sent == [.permissionResponse(requestId: "S1", allow: true, remember: true)])
    }

    // MARK: §33.1 — several cards at once (M26)

    private func bash(_ id: String, agent: PermissionAgent? = nil, reason: PermissionReason? = nil) -> PermissionRequest {
        PermissionRequest(requestId: id, toolName: "Bash", input: .object(["command": .string("touch \(id).txt")]), file: nil,
                          toolUseId: "t-\(id)", agent: agent, reason: reason)
    }

    private let executor = PermissionAgent(agentId: "taskA", agentToolUseId: "agA", subagentType: "executor", description: "compile")
    private let tester = PermissionAgent(agentId: "taskB", agentToolUseId: "agB", subagentType: "test-engineer", description: "test")
    private let git = PermissionReason(code: .gitCommand, message: "reset --hard")

    @Test func whatMayBeAnsweredTogether() {
        let outside = PermissionReason(code: .outsideProject, message: "outside", path: "/elsewhere")
        var send = PermissionRequest(requestId: "S", toolName: "SendMessage", input: .object(["to": .string("x")]))
        send.toSession = b4
        let question = PermissionRequest(requestId: "Q", toolName: AskUserQuestions.toolName, input: .object([:]))
        let plan = PermissionRequest(requestId: "P", toolName: "ExitPlanMode", input: .object([:]))
        #expect(PermissionCardOptions.bundles(bash("A")) && PermissionCardOptions.bundles(bash("O", reason: outside)))
        #expect(!PermissionCardOptions.bundles(bash("G", reason: git)))
        #expect(!PermissionCardOptions.bundles(bash("W", reason: PermissionReason(code: .worktreeCommand, message: "worktree add"))))
        #expect(!PermissionCardOptions.bundles(bash("C", reason: PermissionReason(code: .claudeConfig, message: "settings"))))
        // A reason a newer engine sends and this client does not know: its own answer, as a red one.
        #expect(!PermissionCardOptions.bundles(bash("N", reason: PermissionReason(code: .other("future_code"), message: "new"))))
        #expect(!PermissionCardOptions.bundles(send) && !PermissionCardOptions.bundles(question) && !PermissionCardOptions.bundles(plan))
        // Two or more, oldest first; one alone is no bundle.
        #expect(PermissionCardOptions.bundle([bash("A"), bash("G", reason: git), bash("B")]).map(\.requestId) == ["A", "B"])
        #expect(PermissionCardOptions.bundle([bash("A"), bash("G", reason: git), send]).isEmpty)
        #expect(PermissionCardOptions.agentBundle([bash("A", agent: executor), bash("B", agent: tester), bash("C", agent: executor, reason: git)],
                                                  agentId: "taskA").map(\.requestId) == ["A"])
    }

    @Test func allowAllWaitingAnswersEachOfThem() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let queue = [bash("R1", agent: executor), bash("R2", agent: tester), bash("R3", reason: git)]
        for r in queue { app.handle(.permissionRequest(r)) }
        app.handle(.state(snapshot(seq: 1, queue: queue, running: true)))
        #expect(app.permissionBundle.map(\.requestId) == ["R1", "R2"])
        app.allowWaitingPermissions()
        #expect(sent == [.permissionResponse(requestId: "R1", allow: true), .permissionResponse(requestId: "R2", allow: true)])
        #expect(app.openPermissions.map(\.requestId) == ["R3"])   // the red card still waits for its own answer
        #expect(app.permissionBundle.isEmpty)
    }

    @Test func anAgentAllowedForTheTurnIsAnsweredAsItAsksUntilTheTurnEnds() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        var attention: [AttentionEvent] = []
        app.onAttention = { attention.append($0) }
        let first = bash("R1", agent: executor)
        app.handle(.permissionRequest(first))
        app.handle(.state(snapshot(seq: 1, queue: [first], running: true)))
        app.allowAgentForTurn("taskA")
        #expect(sent == [.permissionResponse(requestId: "R1", allow: true)])
        // Its next request is answered as it comes — no card left open, no notification; another agent's still asks.
        app.handle(.permissionRequest(bash("R2", agent: executor)))
        app.handle(.permissionRequest(bash("R3", agent: tester)))
        #expect(sent.count == 2 && sent.last == .permissionResponse(requestId: "R2", allow: true))
        #expect(attention.map(\.key) == ["perm:R1", "perm:R3"])
        #expect(app.openPermissions.map(\.requestId) == ["R3"])
        // A red card of the same agent still asks.
        app.handle(.permissionRequest(bash("R4", agent: executor, reason: PermissionReason(code: .gitCommand, message: "push --force"))))
        #expect(sent.count == 2)
        // The turn ends: "이번 턴 동안" is over.
        app.handle(.turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0), files: 0,
                            added: 0, deleted: 0))
        app.handle(.permissionRequest(bash("R5", agent: executor)))
        #expect(sent.count == 2)
    }

    // MARK: §18 — [이어서 계속] on the unprompted notice

    @Test func theUnpromptedNoticeOffersToContinue() {
        #expect(SessionNotices.bannerActions(code: "unprompted_blocked", repeats: 1) == [.continueWork])
        #expect(SessionNotices.bannerActions(code: "max_turns", repeats: 1) == [.continueWork])
    }
}
