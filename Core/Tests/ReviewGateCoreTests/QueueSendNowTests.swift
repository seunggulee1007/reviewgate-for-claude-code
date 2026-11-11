import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §50.2 on the Mac: what waits in Claude's turn (`state.session.steering`), and "Send now" on a queued
/// message — into the turn, else stop and send it, else first in line now. Electron: queueSendNow.test.ts.
@Suite @MainActor struct QueueSendNowTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "QueueSendNowTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase, steering: [SteeringMessage] = []) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.session.steering = steering
        let canSend = phase == .reviewing || phase == .idle
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false, blockedReason: canSend ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    private static let image = ComposerImage(mediaType: .png, data: Data([0x89, 0x50, 0x4E, 0x47]), name: "shot.png")

    /// A running turn with three queued messages (the third with an image); every command the store sends.
    private func queued() -> (AppState, () -> [EngineCommand]) {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.requestSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("first")
        app.enqueue("second", mentions: ["src/cart.ts"])
        app.enqueue("with a picture", images: [Self.image])
        return (app, { sent })
    }

    @Test func theSteeringListDecodesLeniently() throws {
        let json = #"{"open":true,"starting":false,"steering":[{"id":"u1","text":"Also README","mentions":["README.md"]},{"id":7},{"id":"u2","text":"then the tests"}]}"#
        let session = try JSONDecoder().decode(SessionInfo.self, from: Data(json.utf8))
        #expect(session.steering == [SteeringMessage(id: "u1", text: "Also README", mentions: ["README.md"]), SteeringMessage(id: "u2", text: "then the tests")])
        let old = try JSONDecoder().decode(SessionInfo.self, from: Data(#"{"open":true,"starting":false}"#.utf8))
        #expect(old.steering.isEmpty)
    }

    @Test func whatWaitsInTheTurnIsShown() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, phase: .running, steering: [SteeringMessage(id: "u1", text: "Also README")])))
        #expect(app.steeringMessages.map(\.text) == ["Also README"])
        app.handle(.state(snapshot(seq: 2, phase: .running)))
        #expect(app.steeringMessages.isEmpty)
    }

    @Test func theDecision() {
        let plain = QueuedMessage(text: "a"), picture = QueuedMessage(text: "a", images: [Self.image])
        #expect(QueuedSendNow.action(for: plain, canSteer: true, running: true) == .steer)
        #expect(QueuedSendNow.action(for: picture, canSteer: true, running: true) == .stopAndSend)
        #expect(QueuedSendNow.action(for: plain, canSteer: false, running: true) == .stopAndSend)
        #expect(QueuedSendNow.action(for: plain, canSteer: false, running: false) == .first)
    }

    @Test func whileClaudeWorksItGoesIntoTheTurnWithItsMentions() async throws {
        let (app, sent) = queued()
        let second = try #require(app.queuedMessages.first { $0.text == "second" })
        #expect(app.queuedSendNowAction(id: second.id) == .steer)
        app.sendQueuedNow(id: second.id)
        #expect(app.queuedMessages.map(\.text) == ["first", "with a picture"])
        for _ in 0..<50 where !sent().contains(where: { if case .steer = $0 { true } else { false } }) { try await Task.sleep(for: .milliseconds(10)) }
        let steers = sent().compactMap { if case let .steer(text, mentions) = $0 { return "\(text) \(mentions)" }; return nil }
        #expect(steers == ["second [\"src/cart.ts\"]"])
    }

    @Test func withAnImageTheTurnStopsAndItGoesRightAfter() throws {
        let (app, sent) = queued()
        let picture = try #require(app.queuedMessages.first { $0.text == "with a picture" })
        #expect(app.queuedSendNowAction(id: picture.id) == .stopAndSend)
        app.sendQueuedNow(id: picture.id)
        #expect(app.queuedMessages.map(\.text) == ["first", "second"])
        #expect(app.sendAfterInterrupt == "with a picture")
        #expect(sent().contains { if case .interrupt = $0 { true } else { false } })
    }

    @Test func aPausedQueueSendsThatMessageFirstAndGoesOn() async throws {
        let (app, sent) = queued()
        app.pauseQueue("The Claude API returned an error.")
        app.handle(.state(snapshot(seq: 2, phase: .idle)))   // paused: nothing goes out by itself
        let second = try #require(app.queuedMessages.first { $0.text == "second" })
        #expect(app.queuedSendNowAction(id: second.id) == .first)
        app.sendQueuedNow(id: second.id)
        #expect(app.queuePausedReason == nil)
        let texts = { sent().compactMap { if case let .send(text, _, _, _) = $0 { return text }; return nil } }
        for _ in 0..<50 where texts().isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        #expect(texts() == ["second"])
        #expect(app.queuedMessages.map(\.text) == ["first", "with a picture"])
    }
}
