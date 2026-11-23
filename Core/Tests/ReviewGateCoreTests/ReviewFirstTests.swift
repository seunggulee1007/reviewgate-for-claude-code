import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §63: review first — the setting, the wire, the quiet row and the composer holding a message.
@Suite @MainActor struct ReviewFirstTests {
    private func freshDefaults() -> UserDefaults {
        UserDefaults(suiteName: "ReviewFirstTests.\(UUID().uuidString)")!
    }

    private func file(_ path: String, _ state: FileReviewState = .pending) -> ChangedFile {
        ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: state)
    }

    private func reviewing(seq: Int, files: [ChangedFile], rule: ReviewFirstInfo?) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: .reviewing, canSend: true, canRequestChanges: false, blockedReason: nil, collectError: nil,
                          pendingCount: files.filter { $0.state == .pending }.count,
                          changesRequestedCount: files.filter { $0.state == .changesRequested }.count, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: "B1", lastReviewSummary: nil)
        s.gate.reviewFirst = rule
        s.changedFiles = files
        return s
    }

    @Test func theSettingDefaultsToEditsAndGoesOutWithHelloAndLive() throws {
        let defaults = freshDefaults()
        #expect(AppSettings.reviewFirst(defaults: defaults) == .edits)
        #expect(AppSettings.engineSettings(defaults: defaults).reviewFirst == "edits")
        defaults.set("prompts", forKey: AppSettings.Key.reviewFirst)
        #expect(AppSettings.engineSettings(defaults: defaults).reviewFirst == "prompts")
        defaults.set("bogus", forKey: AppSettings.Key.reviewFirst)
        #expect(AppSettings.reviewFirst(defaults: defaults) == .edits)
        defaults.set("off", forKey: AppSettings.Key.reviewFirst)
        let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(AppSettings.engineSettings(defaults: defaults))) as? [String: Any]
        #expect(wire?["reviewFirst"] as? String == "off")

        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.pushReviewFirst()
        var expected = EngineSettings()
        expected.reviewFirst = "off"
        #expect(fired == [.setSettings(expected)])
    }

    @Test func gateReviewFirstIsReadLeniently() throws {
        let decode = { (json: String) throws -> GateInfo in try JSONDecoder().decode(GateInfo.self, from: Data(json.utf8)) }
        #expect(try decode(#"{"phase":"reviewing","reviewFirst":{"mode":"prompts","waiting":3,"blocked":2}}"#).reviewFirst
                == ReviewFirstInfo(mode: .prompts, waiting: 3, blocked: 2))
        #expect(try decode(#"{"phase":"reviewing","reviewFirst":null}"#).reviewFirst == nil)
        #expect(try decode(#"{"phase":"reviewing"}"#).reviewFirst == nil)   // an older engine
        #expect(try decode(#"{"phase":"reviewing","reviewFirst":"yes"}"#).reviewFirst == nil)
    }

    @Test func theSettingIsInTheReviewPaneAndFoundInBothLanguages() {
        let entry = SettingsCatalog.entry("reviewFirst")
        #expect(entry?.pane == .review)
        #expect(entry?.applies == .immediately)
        #expect(SettingsCatalog.search("waits for your review").map(\.id).contains("reviewFirst"))
        let korean = ["Claude waits for your review before its next work": "Claude가 다음 작업 전에 리뷰를 기다려요"]
        #expect(SettingsCatalog.search("리뷰를 기다려요", localize: { korean[$0] ?? $0 }).map(\.id) == ["reviewFirst"])
    }

    @Test func aDeniedCallIsAGrayRowThatNeverStopsTheQueue() {
        let code = ReviewFirstText.rowCode
        #expect(SessionNotices.isNotice(code: code, fatal: false))
        #expect(SessionNotices.style(code: code, fatal: false) == .info)
        #expect(QueueStop.of(code: code, fatal: false) == .none)
        var detail = EngineErrorDetail(code: code)
        detail.detail = "3"
        #expect(SessionNotices.errorText(message: "engine words", detail: detail) == ReviewFirstText.blockedText)
        #expect(SessionNotices.secondaryLine(message: "engine words", detail: detail) == nil)
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: freshDefaults())
        app.handle(.error(message: "engine words", fatal: false, scope: .session, detail: detail))
        #expect(app.errorBanner == nil)
        #expect(app.transcript.count == 1)
    }

    @Test func promptsHoldsAPlainMessageUntilTheReviewIsDoneAndAcceptAndSendSendsIt() {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: freshDefaults())
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let waiting = ReviewFirstInfo(mode: .prompts, waiting: 2)
        app.handle(.state(reviewing(seq: 1, files: [file("a.txt"), file("b.txt")], rule: waiting)))
        app.send("go on")
        #expect(sent.isEmpty)
        #expect(app.queuedMessages.map(\.text) == ["go on"])
        #expect(app.reviewFirstHeldMessage?.text == "go on")
        #expect(app.queueHoldReason == ReviewFirstText.queueHold)
        // A slash command is never held.
        app.send("/compact")
        #expect(sent == [.send(text: "/compact", acceptPending: false)])
        // [N개 수락 후 보내기]: every pending file accepted, then the held message.
        #expect(app.reviewFirstAcceptBlocker == nil)
        #expect(app.acceptAndSendHeld())
        #expect(sent.last == .send(text: "go on", acceptPending: true))
        #expect(app.queuedMessages.isEmpty)
    }

    @Test func aHeldMessageGoesOnceNothingWaitsAndAcceptAndSendIsOffWithAChangesRequestedFile() {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: freshDefaults())
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(reviewing(seq: 1, files: [file("a.txt"), file("b.txt", .changesRequested)], rule: ReviewFirstInfo(mode: .prompts, waiting: 2))))
        app.send("go on")
        #expect(sent.isEmpty)
        #expect(app.reviewFirstAcceptBlocker == ReviewFirstText.changesRequestedBlocker)
        #expect(!app.acceptAndSendHeld())
        // The user decided every file: the rule lets go and the queue sends it.
        app.handle(.state(reviewing(seq: 2, files: [file("a.txt", .accepted), file("b.txt", .rejected)], rule: nil)))
        #expect(sent == [.send(text: "go on", acceptPending: false)])
    }

    @Test func editsNeverHoldAMessage() {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: freshDefaults())
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(reviewing(seq: 1, files: [file("a.txt")], rule: ReviewFirstInfo(mode: .edits, waiting: 1, blocked: 1))))
        app.send("why?")
        #expect(sent == [.send(text: "why?", acceptPending: false)])
        #expect(app.reviewFirstHeldMessage == nil)
    }
}
