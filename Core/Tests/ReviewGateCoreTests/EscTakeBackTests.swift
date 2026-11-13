import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §56.2 on the Mac: Esc while Claude works with messages waiting stops the turn and gives back what Claude
/// has not read — the messages in its turn and the whole queue — in front of the draft; ↑ in an empty box does the same
/// without stopping. Electron: escTakeBack.test.ts.
@Suite @MainActor struct EscTakeBackTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "EscTakeBackTests.\(UUID().uuidString)")!)
    }

    private func running(steering: [SteeringMessage]) -> ReviewState {
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.session.steering = steering
        s.gate = GateInfo(phase: .running, canSend: false, canRequestChanges: false, blockedReason: .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    private static let image = ComposerImage(mediaType: .png, data: Data([0x89, 0x50, 0x4E, 0x47]), name: "shot.png")
    private static let waiting = [SteeringMessage(id: "u1", text: "Also README", mentions: ["README.md"]), SteeringMessage(id: "u2", text: "then the tests")]

    /// A running turn with two messages in it and two queued (the second with an image and a mention).
    private func busy() -> AppState {
        let app = makeState()
        app.commandSink = { _ in }
        app.requestSink = { _ in }
        app.handle(.state(running(steering: Self.waiting)))
        app.enqueue("queued one")
        app.enqueue("queued two", mentions: ["src/cart.ts"], images: [Self.image])
        return app
    }

    @Test func theWire() throws {
        let data = try JSONEncoder().encode(EngineCommandEnvelope(id: "c1", command: .interruptTakeBack))
        let sent = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(sent["type"] as? String == "interrupt")
        #expect(sent["takeBack"] as? Bool == true)
        let plain = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(EngineCommandEnvelope(id: nil, command: .interrupt))) as? [String: Any])
        #expect(plain["takeBack"] == nil)
        let json = #"{"type":"interrupted","id":"c1","takenBack":[{"id":"u2","text":"then the tests"}],"read":["u1"]}"#
        let event = try JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8))
        #expect(event == .interrupted(InterruptedReply(id: "c1", takenBack: [SteeringMessage(id: "u2", text: "then the tests")], read: ["u1"])))
        #expect(event.replyId == "c1")
    }

    @Test func escGivesEverythingBackInFrontInOrder() async {
        let app = busy()
        var asked: [EngineCommand] = []
        app.replySink = { command in
            asked.append(command)
            return .interrupted(InterruptedReply(takenBack: Self.waiting, read: []))
        }
        #expect(app.hasUnsentWaiting)
        await app.interruptGivingBack()
        #expect(asked == [.interruptTakeBack])
        #expect(app.queuedMessages.isEmpty)   // the queue does not go on after the stop
        let back = app.taskForComposer
        #expect(back?.text == "Also README\n\nthen the tests\n\nqueued one\n\nqueued two")
        #expect(back?.mentions == ["README.md", "src/cart.ts"])
        #expect(back?.images == [Self.image])
        #expect(back?.atFront == true)
        #expect(app.steerTakeBackNotice == nil)
    }

    @Test func whatClaudeReadStaysAndTheNoticeSaysSo() async {
        let app = busy()
        app.replySink = { _ in .interrupted(InterruptedReply(takenBack: [Self.waiting[1]], read: ["u1"])) }
        await app.interruptGivingBack()
        #expect(app.taskForComposer?.text == "then the tests\n\nqueued one\n\nqueued two")
        #expect(app.steerTakeBackNotice?.text == SteerTakeBackNotice.alreadyRead)
        #expect(GivenBack.readNotice(2)?.text != SteerTakeBackNotice.alreadyRead)
        #expect(GivenBack.readNotice(0) == nil)
    }

    @Test func aFailedInterruptStillGivesTheQueueBack() async {
        let app = busy()
        app.replySink = { _ in throw EngineClientError.stopped }
        await app.interruptGivingBack()
        #expect(app.taskForComposer?.text == "queued one\n\nqueued two")
        #expect(app.queuedMessages.isEmpty)
    }

    @Test func upBringsEveryWaitingMessageBackWithoutStopping() async {
        let app = busy()
        var sent: [EngineCommand] = []
        app.requestSink = { command in
            sent.append(command)
            if command == .steerTakeBack(messageId: "u1") { throw EngineClientError.refused("steer_already_read: read", code: "steer_already_read") }
        }
        #expect(app.pullBackWaiting())
        #expect(app.queuedMessages.isEmpty)
        while app.taskForComposer == nil { await Task.yield() }
        #expect(sent == [.steerTakeBack(messageId: "u1"), .steerTakeBack(messageId: "u2")])   // no interrupt
        #expect(app.taskForComposer?.text == "then the tests\n\nqueued one\n\nqueued two")
        #expect(app.taskForComposer?.atFront == true)
        #expect(app.steerTakeBackNotice?.text == SteerTakeBackNotice.alreadyRead)
    }

    @Test func upWithNothingWaitingIsTheHistory() {
        let app = makeState()
        app.handle(.state(running(steering: [])))
        #expect(!app.hasUnsentWaiting)
        #expect(!app.pullBackWaiting())
    }
}
