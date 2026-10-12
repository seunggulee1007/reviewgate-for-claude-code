import Foundation
import Testing
@testable import ReviewGateCore

/// wave2 check-clients: regressions found reading the wave1 client changes against the handoff (Mac side).
@Suite @MainActor struct ClientCheckTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ClientCheckTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase = .idle) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil,
                                canRestart: true)
        s.session.ready = true
        let canSend = phase == .idle || phase == .reviewing
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false, blockedReason: canSend ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    // MARK: §29 fallback row

    /// "이 메시지 처리하기" sends the other session's message as the user's own once — a second click (or a double click)
    /// neither sends nor queues it again, and the row says it went out (as in Electron).
    @Test func unpromptedPeerMessageGoesOutOnce() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        let message = PeerMessage(id: "u1", from: "uds:/tmp/cc-socks/77.sock", fromName: "terminal-a", state: .delivered,
                                  body: "Fix the build", unprompted: true)
        app.handle(.peerMessage(message))
        #expect(!app.isUnpromptedPeerMessageHandled(message))
        app.handleUnpromptedPeerMessage(message)
        app.handleUnpromptedPeerMessage(message)
        #expect(sent == [.send(text: PeerText.unpromptedSendText(message))])
        #expect(app.isUnpromptedPeerMessageHandled(message))
        // Busy: queued once, not twice.
        app.handle(.state(snapshot(seq: 2, phase: .running)))
        let other = PeerMessage(id: "u2", from: "uds:/tmp/cc-socks/77.sock", fromName: "terminal-a", state: .delivered,
                                body: "Then the tests", unprompted: true)
        app.handleUnpromptedPeerMessage(other)
        app.handleUnpromptedPeerMessage(other)
        #expect(app.queuedMessages.map(\.text) == [PeerText.unpromptedSendText(other)])
        // Nothing to hand over without a body.
        let empty = PeerMessage(id: "u3", from: "uds:/tmp/cc-socks/77.sock", fromName: nil, state: .delivered, unprompted: true)
        app.handleUnpromptedPeerMessage(empty)
        #expect(app.queuedMessages.count == 1)
        #expect(!app.isUnpromptedPeerMessageHandled(empty))
    }

    /// In `auto` (§29 "쉴 때 자동 처리") the engine takes a held message itself once Claude is idle — nothing waits for the
    /// user, so the Changes segment does not say "waiting for you" (no notification is posted either; Electron does the same).
    @Test func heldMessageInAutoModeIsNotWaitingForTheUser() {
        let app = makeState()
        var s = snapshot(seq: 1, phase: .running)
        s.session.peerInbound = .auto
        s.session.peerInbox = [PeerMessage(id: "m1", from: "uds:/tmp/cc-socks/4242.sock", fromName: "acme-b4", state: .held)]
        app.handle(.state(s))
        #expect(app.changesTabStatus == .working)
        s.seq = 2
        s.session.peerInbound = .ask
        app.handle(.state(s))
        #expect(app.changesTabStatus == .waiting)
    }

    // MARK: M7 / §2.9 Stop & send

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
    }

    /// "Stop & send": the interrupted turn ends before the send behind it runs; when that send's snapshot A then fails
    /// (`error{send_failed | lfs_missing}`, then `ok`) the message waits first in the stopped queue — it was dropped (the
    /// composer was already cleared). As in Electron.
    @Test func stopAndSendWhoseSnapshotFailsWaitsInTheQueue() async {
        let app = makeState()
        app.commandSink = { _ in }
        var requests: [EngineCommand] = []
        app.requestSink = { command in
            requests.append(command)
            if case .send = command {
                app.handle(.state(self.snapshot(seq: 3, phase: .reviewing)))   // the interrupted turn is over
                app.handle(.error(message: "snapshot failed", fatal: false, scope: .git, detail: EngineErrorDetail(code: "send_failed")))
            }
        }
        app.handle(.state(snapshot(seq: 1)))
        app.handle(.state(snapshot(seq: 2, phase: .running)))
        app.interruptAndSend("이 방향으로 다시 해 줘")
        await waitUntil { !requests.isEmpty && app.queuePausedReason != nil }
        #expect(app.queuedMessages.map(\.text) == ["이 방향으로 다시 해 줘"])
        #expect(app.queuePausedReason != nil)
        // Nothing went out twice; Resume sends it again.
        #expect(requests.count == 1)
    }

    /// §35.1: the engine refuses a send whose snapshot A failed (`result{ok:false, code: lfs_missing}`, no error event): the
    /// message waits first in the stopped queue, and the banner says what the error event said — with its code.
    @Test func refusedSendForWantOfLfsKeepsTheMessageAndSaysWhy() async {
        let app = makeState()
        app.commandSink = { _ in }
        app.requestSink = { command in
            if case .send = command { throw EngineClientError.refused("lfs_missing:git-lfs filter is missing", code: "lfs_missing") }
        }
        app.handle(.state(snapshot(seq: 1)))
        app.send("LFS 저장소에서 보내기")
        await waitUntil { app.queuePausedReason != nil }
        #expect(app.queuedMessages.map(\.text) == ["LFS 저장소에서 보내기"])
        #expect(app.queuePausedReason == SessionNotices.lfsMissingText)
        #expect(app.errorBanner?.code == "lfs_missing" && app.errorBanner?.message == SessionNotices.lfsMissingText)
    }

    // MARK: §33.3 reason card

    /// A reason card ("…리뷰에 잡히지 않습니다", red) also drew "No risky patterns found" right below it — "outside this
    /// window's review" and "all clear" on one card. The all-clear line is left out there; real risks still show.
    @Test func reasonCardHasNoAllClearRiskLine() {
        let file = "/repo/.claude/worktrees/wt1/src/A.java"
        let nested = PermissionRequest(requestId: "N1", toolName: "Edit", input: .object(["file_path": .string(file)]), file: file,
                                       toolUseId: nil, reason: PermissionReason(code: .nestedRepository, message: "m", path: "/repo/.claude/worktrees/wt1"))
        let calm = CommandRisk.assess(nested, projectRoot: "/repo")
        #expect(calm.isEmpty)
        #expect(!PermissionCardOptions.showsRiskLine(nested, risk: calm))
        let risky = PermissionRequest(requestId: "N2", toolName: "Bash", input: .object(["command": .string("cd .claude/worktrees/wt1 && rm -rf build")]),
                                      file: nil, toolUseId: nil, reason: PermissionReason(code: .nestedRepository, message: "m", path: "/repo/.claude/worktrees/wt1"))
        let flagged = CommandRisk.assess(risky, projectRoot: "/repo")
        #expect(flagged.kinds.contains(.deletion))
        #expect(PermissionCardOptions.showsRiskLine(risky, risk: flagged))
        // No reason: the line stays, calm or not; SendMessage has none.
        let plain = PermissionRequest(requestId: "P1", toolName: "Bash", input: .object(["command": .string("npm test")]))
        #expect(PermissionCardOptions.showsRiskLine(plain, risk: CommandRisk.assess(plain, projectRoot: "/repo")))
        let send = PermissionRequest(requestId: "S1", toolName: "SendMessage", input: .object(["to": .string("a"), "message": .string("b")]))
        #expect(!PermissionCardOptions.showsRiskLine(send, risk: CommandRisk(kinds: [])))
    }

    // MARK: §33.2 SendMessage card

    /// The CLI's SendMessage also carries protocol messages as an object (a teammate's `shutdown_response`, a plan approval —
    /// Claude Code 2.1.309): the card showed "—" for those, so the user approved a message without seeing it.
    @Test func sendMessageCardShowsAProtocolMessage() {
        let structured = PermissionRequest(requestId: "S1", toolName: "SendMessage", input: .object([
            "to": .string("team-lead"),
            "message": .object(["type": .string("shutdown_response"), "request_id": .string("shutdown-7"), "approve": .bool(true)]),
        ]))
        let content = SendMessageCardContent(request: structured)
        #expect(content.isStructured)
        #expect(content.message.contains("\"type\" : \"shutdown_response\""))
        #expect(content.message.contains("\"approve\" : true"))
        // Plain text stays as written; nothing at all stays empty (the card says "—").
        let plain = SendMessageCardContent(request: PermissionRequest(requestId: "S2", toolName: "SendMessage", input: .object([
            "to": .string("acme-b4"), "message": .string("All tests pass."),
        ])))
        #expect(!plain.isStructured && plain.message == "All tests pass.")
        let none = SendMessageCardContent(request: PermissionRequest(requestId: "S3", toolName: "SendMessage", input: .object([
            "to": .string("acme-b4"),
        ])))
        #expect(!none.isStructured && none.message.isEmpty)
    }
}
