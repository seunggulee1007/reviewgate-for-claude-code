import Foundation
import Testing
@testable import ReviewGateCore

/// wave1 mac-session: docs/PROTOCOL.md §29 on the client — the inbox card (`state.session.peerInbox`), `peer_accept` /
/// `peer_dismiss` / `peer_set` and their refusals, the transcript rows, the external turn and the attention event.
@Suite @MainActor struct PeerInboxTests {
    private func makeState(_ defaults: UserDefaults? = nil) -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults ?? UserDefaults(suiteName: "PeerInboxTests.\(UUID().uuidString)")!)
    }

    private func held(_ id: String, name: String? = "acme-b4", cause: String? = "explicit-setting") -> PeerMessage {
        PeerMessage(id: id, from: "uds:/tmp/cc-socks/4242.sock", fromName: name, cause: cause, receivedAt: "2026-10-22T01:00:00Z", state: .held)
    }

    private func snapshot(seq: Int, phase: GatePhase = .idle, inbox: [PeerMessage] = [], mode: PeerInboundMode? = .ask,
                          external: ExternalTurn? = nil, blocked: BlockedReason? = nil, permission: PermissionRequest? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: permission,
                                canRestart: true)
        s.session.ready = true
        s.session.peerInbound = mode
        s.session.peerInbox = inbox
        s.session.externalTurn = external
        let canSend = (phase == .idle || phase == .reviewing) && external == nil && permission == nil
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false,
                          blockedReason: canSend ? nil : (blocked ?? (permission != nil ? .awaitingPermission : .running)),
                          collectError: nil, pendingCount: phase == .reviewing ? 1 : 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: phase == .reviewing ? "B1" : nil, lastReviewSummary: nil)
        if phase == .reviewing {
            s.changedFiles = [ChangedFile(path: "a.txt", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"])]
        }
        return s
    }

    private func peerRows(_ app: AppState) -> [PeerMessage] {
        app.transcript.compactMap { if case let .peerMessage(_, m) = $0 { return m }; return nil }
    }

    // MARK: - Card

    /// Handoff §6 #22 / #23: one held message is one card; a second joins it; "Claude가 처리" sends every held id.
    @Test func heldMessagesGroupAndAcceptSendsEveryId() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, inbox: [held("m1")])))
        #expect(app.heldPeerMessages.map(\.id) == ["m1"])
        app.handle(.state(snapshot(seq: 2, inbox: [held("m1"), held("m2", name: nil)])))
        #expect(app.heldPeerMessages.map(\.id) == ["m1", "m2"])
        #expect(app.peerAcceptBlockedReason == nil)
        app.acceptPeerMessages()
        #expect(sent == [.peerAccept(ids: ["m1", "m2"])])
        app.dismissPeerMessages()
        #expect(sent.last == .peerDismiss(ids: ["m1", "m2"]))
        app.setProjectPeerInbound(.off)
        #expect(sent.last == .peerSet(mode: .off))
    }

    @Test func acceptWaitsForTheGateWithTheReason() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running, inbox: [held("m1")])))
        #expect(app.peerAcceptBlockedReason == PeerText.waitForWork)
        app.acceptPeerMessages()
        #expect(sent.isEmpty)
        let req = PermissionRequest(requestId: "r", toolName: "Bash", input: .object([:]))
        app.handle(.state(snapshot(seq: 2, phase: .running, inbox: [held("m1")], permission: req)))
        #expect(app.peerAcceptBlockedReason == PeerText.waitForWork)
        app.handle(.state(snapshot(seq: 3, inbox: [held("m1")], external: ExternalTurn(since: "t"))))
        #expect(app.peerAcceptBlockedReason == PeerText.waitForOtherWork)
        // A standing review: allowed, with a note that its changes join the review.
        app.handle(.state(snapshot(seq: 4, phase: .reviewing, inbox: [held("m1")])))
        #expect(app.peerAcceptBlockedReason == nil)
        #expect(app.peerAcceptNote == PeerText.reviewNote)
        // Delivering: the card spins and the buttons wait.
        var delivering = held("m1")
        delivering.state = .delivering
        app.handle(.state(snapshot(seq: 5, phase: .running, inbox: [delivering])))
        #expect(app.isPeerDelivering && app.peerAcceptBlockedReason == PeerText.delivering)
        app.dismissPeerMessages()
        #expect(sent.isEmpty)
    }

    /// Handoff §6 #24: `peer_inbox_changed` refreshes the card with a notice; `peer_none` removes it; `gate_closed` says why.
    @Test func refusalsUpdateTheCard() async {
        let app = makeState()
        var refusal: EngineClientError?
        app.requestSink = { _ in if let refusal { throw refusal } }
        app.handle(.state(snapshot(seq: 1, inbox: [held("m1")])))

        refusal = .refused("peer_inbox_changed:m1, m2", code: "peer_inbox_changed")
        app.acceptPeerMessages()
        await eventually { app.peerNotice != nil && !app.isPeerBusy }
        #expect(app.peerNotice == PeerText.inboxChanged)

        refusal = .refused("gate_closed:external_turn", code: "gate_closed")
        app.acceptPeerMessages()
        await eventually { app.peerNotice == PeerText.waitForOtherWork }
        #expect(app.peerNotice == PeerText.waitForOtherWork)

        refusal = .refused("peer_none", code: "peer_none")
        app.dismissPeerMessages()
        await eventually { app.peerInbox.isEmpty }
        #expect(app.peerInbox.isEmpty && app.peerNotice == nil)

        // A success clears the notice; the snapshot without messages clears it too.
        app.handle(.state(snapshot(seq: 2, inbox: [held("m3")])))
        refusal = .refused("peer_release_failed:no released frame", code: "peer_release_failed")
        app.acceptPeerMessages()
        await eventually { app.peerNotice != nil && !app.isPeerBusy }
        #expect(app.peerNotice == SessionNotices.peerReleaseFailedText)
        app.handle(.state(snapshot(seq: 3, inbox: [])))
        #expect(app.peerNotice == nil)
    }

    /// `peer_release_failed`: with the card on screen the card says it (no second banner); the row stays.
    @Test func releaseFailureNoticeGoesToTheCard() {
        let app = makeState()
        app.commandSink = { _ in }
        app.handle(.state(snapshot(seq: 1, inbox: [held("m1")])))
        app.handle(.error(message: "not released", fatal: false, scope: .session, detail: EngineErrorDetail(code: "peer_release_failed")))
        #expect(app.errorBanner == nil)
        #expect(app.peerNotice == SessionNotices.peerReleaseFailedText)
        #expect(app.transcript.count == 1)
        #expect(app.queuePausedReason == nil)
    }

    // MARK: - Rows

    /// Handoff §6 #25: the delivered message opens its turn — live (before the turn's tools) and restored.
    @Test func deliveredRowOpensTheTurn() {
        let app = makeState()
        var delivered = held("m1")
        delivered.state = .delivered
        delivered.body = "Please run the tests"
        delivered.verifiedPeerPid = 4242
        delivered.turn = 3
        app.handle(.peerMessage(held("m1")))                  // held: no row (the card shows it)
        #expect(app.transcript.isEmpty)
        app.handle(.peerMessage(delivered))
        app.handle(.toolUse(id: "t1", name: "Bash", input: .object([:]), file: nil))
        app.handle(.peerMessage(delivered))                   // a repeat adds nothing
        #expect(app.transcript.count == 2)
        guard case let .peerMessage(_, first) = app.transcript.first else { Issue.record("not a peer row"); return }
        #expect(first == delivered)
        #expect(PeerText.deliveredHeader(first).contains("acme-b4"))

        let restored = makeState()
        restored.handle(.transcriptRestore(items: [
            TranscriptItem(at: "2026-10-22T01:00:00Z", turn: 3, kind: .peerMessage(delivered)),
            TranscriptItem(at: "2026-10-22T01:00:01Z", turn: 3, kind: .toolUse(id: "t1", name: "Bash", input: .object([:]), file: nil)),
        ]))
        guard case .peerMessage = restored.transcript.first else { Issue.record("not a peer row first"); return }
        #expect(restored.transcript.count == 2)
    }

    /// Handoff §6 #26: a dismissed message leaves a "declined" row; expired / discarded read differently.
    @Test func droppedRowsByOutcome() {
        let app = makeState()
        var refused = held("m1")
        refused.state = .dropped
        refused.outcome = "refused"
        app.handle(.peerMessage(refused))
        #expect(peerRows(app).map(\.outcome) == ["refused"])
        #expect(PeerText.droppedText(refused).contains("acme-b4"))
        var expired = refused
        expired.outcome = "expired"
        var discarded = refused
        discarded.outcome = "discarded"
        var odd = refused
        odd.outcome = "buffer_full"
        let texts = Set([refused, expired, discarded, odd].map(PeerText.droppedText))
        #expect(texts.count == 4)
        #expect(PeerText.droppedText(odd).contains("buffer_full"))
    }

    /// Handoff §6 #28: "이 메시지 처리하기" on an unprompted row sends the body as a normal message.
    @Test func unpromptedRowSendsTheBodyAsAMessage() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        let message = PeerMessage(id: "m9", from: "uds:/tmp/cc-socks/77.sock", fromName: "terminal-a", state: .delivered,
                                  body: "Look at README", unprompted: true)
        app.handle(.peerMessage(message))
        #expect(peerRows(app).first?.unprompted == true)
        #expect(app.queuePausedReason == nil && app.errorBanner == nil)
        app.handleUnpromptedPeerMessage(message)
        #expect(sent == [.send(text: PeerText.unpromptedSendText(message))])
        #expect(PeerText.unpromptedSendText(message).hasSuffix("\nLook at README"))
        #expect(PeerText.unpromptedSendText(message).contains("terminal-a"))
        // While busy it waits in the queue instead (another message: one goes out once, wave2 check-clients).
        app.handle(.state(snapshot(seq: 2, phase: .running)))
        let later = PeerMessage(id: "m10", from: "uds:/tmp/cc-socks/77.sock", fromName: "terminal-a", state: .delivered,
                                body: "And the CHANGELOG", unprompted: true)
        app.handleUnpromptedPeerMessage(later)
        #expect(app.queuedMessages.map(\.text) == [PeerText.unpromptedSendText(later)])
    }

    // MARK: - External turn (§29, handoff §6 #27)

    @Test func externalTurnQueuesAndSendsAfterwards() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let turn = ExternalTurn(commandUuid: "c1", since: "t", peer: nil)
        app.handle(.state(snapshot(seq: 1, external: turn)))
        #expect(app.isExternalTurn && !app.canSend)
        #expect(app.cannotSendReason == PeerText.externalTurnComposer(turn))
        app.enqueue("while the other turn runs")
        #expect(sent.isEmpty)
        #expect(app.queueHoldReason == PeerText.waitForExternalTurn)
        app.handle(.state(snapshot(seq: 2)))
        #expect(sent == [.send(text: "while the other turn runs")])
        #expect(app.queuePausedReason == nil)
    }

    // MARK: - Attention, settings

    @Test func heldMessageNotifiesUnlessAuto() {
        let app = makeState()
        var attention: [AttentionEvent] = []
        app.onAttention = { attention.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        app.handle(.peerMessage(held("m1")))
        #expect(attention.map(\.kind) == [.peerMessage])
        #expect(attention.first?.body == PeerText.sentMessage(from: "acme-b4"))
        #expect(attention.first?.key == "peer:m1")
        app.handle(.state(snapshot(seq: 2, mode: .auto)))
        var verified = held("m2")
        verified.sender = PeerSessionInfo(address: "uds:/tmp/cc-socks/4242.sock", pid: 4242, name: "acme-b4", entrypoint: "cli")
        app.handle(.peerMessage(verified))
        #expect(attention.count == 1)   // auto: the engine runs a message from a live session of the user's by itself
        app.handle(.peerMessage(held("m3")))
        #expect(attention.map(\.key) == ["peer:m1", "peer:m3"])   // r2-peers: one no live session vouches for waits for the user
    }

    @Test func globalModeIsPushedToTheEngine() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.updatePeerInbound(.off)
        var expected = EngineSettings()
        expected.peerInbound = .off
        #expect(sent == [.setSettings(expected)])
    }

    // MARK: - daily-03

    @Test func changesTabStatusFollowsTheSession() {
        let app = makeState()
        #expect(app.changesTabStatus == .idle)
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        #expect(app.changesTabStatus == .working)
        let req = PermissionRequest(requestId: "r", toolName: "Bash", input: .object([:]))
        app.handle(.state(snapshot(seq: 2, phase: .running, permission: req)))
        #expect(app.changesTabStatus == .waiting)
        app.handle(.state(snapshot(seq: 3, phase: .reviewing)))
        #expect(app.changesTabStatus == .review(1))
        app.handle(.state(snapshot(seq: 4, inbox: [held("m1")])))
        #expect(app.changesTabStatus == .waiting)
        app.handle(.state(snapshot(seq: 5, external: ExternalTurn(since: "t"))))
        #expect(app.changesTabStatus == .working)
    }
}
