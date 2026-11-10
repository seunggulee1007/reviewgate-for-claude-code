import Foundation
import Testing
@testable import ReviewGateCore

/// wave5 w5-model: docs/PROTOCOL.md §43.4 auto model — the fields read leniently, the words of a turn's model, the setting
/// pushed to the engine and the composer's one-message model.
@MainActor @Suite struct AutoModelTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "AutoModelTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, running: Bool = false) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "c1", model: "claude-sonnet-5-5", capabilities: nil,
                                pendingPermission: nil, canRestart: true)
        s.sessions = SessionsInfo(list: [], currentId: "c1", openTabIds: ["c1"])
        s.gate = GateInfo(phase: running ? .running : .idle, canSend: !running, canRequestChanges: false, blockedReason: running ? .running : nil,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A", turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    private let design = #"{"model":"claude-opus-5-5","family":"opus","reason":"design","policy":"balanced","by":"auto","switched":true,"from":"claude-sonnet-5-5"}"#

    @Test func readsTheFieldsLeniently() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"{"type":"user_message","text":"설계해 줘","turn":3,"autoModel":\#(design)}"#)
        let choice = AutoModelChoice(model: "claude-opus-5-5", family: "opus", reason: "design", policy: .balanced, by: .auto, switched: true, from: "claude-sonnet-5-5")
        #expect(event == .userMessage(text: "설계해 줘", turn: 3, autoModel: choice))
        // An older engine: no field, the event as before; a malformed one is dropped, never the message.
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"user_message","text":"hi","turn":1}"#) == .userMessage(text: "hi", turn: 1))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"user_message","text":"hi","turn":1,"autoModel":{"model":7}}"#) == .userMessage(text: "hi", turn: 1))
        // Unknown policy / by read as the defaults.
        let odd = try decode(AutoModelChoice.self, #"{"model":null,"reason":"manual","policy":"turbo","by":"robot"}"#)
        #expect(odd == AutoModelChoice(model: nil, reason: "manual", policy: .balanced, by: .auto))
        let row = try decode(TranscriptItem.self, #"{"at":"t","turn":3,"kind":"user_message","text":"설계해 줘","autoModel":\#(design)}"#)
        #expect(row.kind == .userMessage(text: "설계해 줘", autoModel: choice))
        let summary = try decode(TurnSummary.self, #"{"turn":3,"files":[],"commands":[],"plan":null,"autoModel":\#(design)}"#)
        #expect(summary.autoModel == choice)
    }

    @Test func stateAndHudCarryTheLastPickAndTheCounts() throws {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        #expect(app.autoModel == nil)
        let session = try decode(SessionInfo.self, #"{"open":true,"starting":false,"sessionId":"c1","model":"m","capabilities":null,"pendingPermission":null,"autoModel":\#(design)}"#)
        #expect(session.autoModel?.reason == "design")
        let hud = try decode(HUDWire.self, #"{"contextTokens":1,"contextWindow":null,"sessionCostUSD":0,"turnCount":1,"lastTurnMs":0,"activity":{"kind":"idle"},"subagentDepth":0,"turnStartedAt":null,"autoModelCounts":[{"family":"opus","count":2},{"family":"haiku","count":0},{"nope":1}]}"#)
        #expect(hud.autoModelCounts == [AutoModelCount(family: "opus", count: 2)])
        #expect(AutoModelText.countsLine([AutoModelCount(family: "opus", count: 3), AutoModelCount(family: "sonnet", count: 5)]) == "opus 3 · sonnet 5")
        #expect(AutoModelText.countsLine([]) == nil)
    }

    @Test func wordsOfATurnsModel() {
        let choice = AutoModelChoice(model: "claude-opus-5-5", family: "opus", reason: "design", switched: true, from: "claude-sonnet-5-5")
        #expect(AutoModelText.switchLine(choice) == String(localized: "Switched the model to opus — design decision", bundle: .module))
        #expect(AutoModelText.switchLine(AutoModelChoice(model: "claude-opus-5-5", family: "opus", reason: "design")) == nil)
        #expect(AutoModelText.summaryLine(choice) == String(localized: "Model: opus (Auto · design decision)", bundle: .module))
        #expect(AutoModelText.summaryLine(AutoModelChoice(model: "claude-haiku-5-5", family: "haiku", reason: "user_choice", by: .user))
                == String(localized: "Model: haiku (your pick for this message)", bundle: .module))
        #expect(AutoModelText.summaryLine(AutoModelChoice(model: nil, reason: "manual", by: .manual))
                == String(localized: "Model: Default model (back to your model)", bundle: .module))
        #expect(AutoModelText.chipText(nil) == String(localized: "Auto", bundle: .module))
        #expect(AutoModelText.chipText(choice) == String(localized: "Auto · opus", bundle: .module))
        #expect(AutoModelText.reason("brand_new") == "brand_new")
        #expect(AutoModelText.nextMessageLabel("claude-haiku-5-5") == String(localized: "This time haiku", bundle: .module))
    }

    @Test func oneMessageOptionsAreTheNewestOfEachFamily() {
        let models = [ModelOption(value: "default", displayName: "Default", resolvedModel: "claude-sonnet-5-5"),
                      ModelOption(value: "claude-opus-4-1-20250805", displayName: "Opus 4.1"),
                      ModelOption(value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5-5"),
                      ModelOption(value: "opus[1m]", displayName: "Opus 1M", resolvedModel: "claude-opus-5-5[1m]"),
                      ModelOption(value: "claude-sonnet-5-5", displayName: "Sonnet 5.5")]
        let options = AutoModelText.oneMessageOptions(models)
        #expect(options.map(\.family) == ["opus", "sonnet"])
        #expect(options.map(\.value) == ["opus", "claude-sonnet-5-5"])
    }

    @Test func theSettingGoesWithHelloAndLiveWithSetSettings() {
        let defaults = UserDefaults(suiteName: "AutoModelTests.settings.\(UUID().uuidString)")!
        #expect(AppSettings.engineSettings(defaults: defaults).modelMode == "manual")
        #expect(AppSettings.engineSettings(defaults: defaults).modelAutoPolicy == "balanced")
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        #expect(app.modelMode == .manual)
        #expect(app.autoModelChipText == nil)
        app.setModelMode(.auto, policy: .cost)
        #expect(app.modelMode == .auto && app.autoModelPolicy == .cost)
        #expect(app.autoModelChipText == String(localized: "Auto", bundle: .module))
        var expected = EngineSettings()
        expected.modelMode = "auto"
        expected.modelAutoPolicy = "cost"
        #expect(sent == [.setSettings(expected)])
        #expect(AppSettings.engineSettings(defaults: defaults).modelMode == "auto")
    }

    @Test func theComposersOneMessageModelGoesWithTheNextMessageOnly() throws {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        app.setNextMessageModel("claude-opus-5-5")
        app.send("설계해 줘")
        app.handle(.state(snapshot(seq: 2)))
        app.send("다음")
        #expect(sent == [.sendWithModel(text: "설계해 줘", model: "claude-opus-5-5"), .send(text: "다음")])
        #expect(app.nextMessageModel == nil)
        // While Claude works the message waits in the queue with its model.
        app.handle(.state(snapshot(seq: 3, running: true)))
        app.setNextMessageModel("claude-haiku-5-5")
        app.enqueue("오타 고쳐 줘")
        #expect(app.queuedMessages.first?.model == "claude-haiku-5-5")
        app.handle(.state(snapshot(seq: 4)))
        #expect(sent.last == .sendWithModel(text: "오타 고쳐 줘", model: "claude-haiku-5-5"))
        // On the wire it is `send` with `model`.
        let data = try JSONEncoder().encode(EngineCommandEnvelope(command: .sendWithModel(text: "hi", model: "sonnet")))
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["type"] as? String == "send" && json["model"] as? String == "sonnet" && json["text"] as? String == "hi")
    }
}
