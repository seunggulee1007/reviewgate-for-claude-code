import Foundation
import Testing
@testable import ReviewGateCore

/// §40.3 (wave4b w4b-side): side questions you can trust — the web setting, the fork point and [최신 대화로 다시 묻기], quote
/// anchors, the queued record, the chat-switch warning and the model choices. Same rules as Electron's `sideTrust.test.ts`.
@Suite @MainActor struct SideTrustTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "SideTrustTests.\(UUID().uuidString)")! }

    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func thread(fork: String = #"{"mode":"fork_full","fromSessionId":"m","at":null,"atTurn":3,"runningTurn":null}"#,
                        promotions: String = "[]", anchor: String = "null") throws -> SideThread {
        let raw = #"{"id":"th1","mainSessionId":"chat-1","anchor":\#(anchor),"createdAt":"","updatedAt":"","title":"왜?","messages":[{"role":"user","text":"이 매퍼 왜 바꿨어?","at":""},{"role":"assistant","text":"N+1 때문이에요.","at":""}],"status":"idle","error":null,"sessionId":"side-1","fork":\#(fork),"costUSD":0,"promotions":\#(promotions)}"#
        return try JSONDecoder().decode(SideThread.self, from: Data(raw.utf8))
    }

    @Test func webIsOffUnlessChosen() {
        let d = defaults()
        #expect(AppSettings.sideWeb(defaults: d) == .off)
        d.set(true, forKey: AppSettings.Key.sideAllowWeb)   // the old toggle's value does not turn it on
        #expect(AppSettings.sideWeb(defaults: d) == .off)
        #expect(AppSettings.engineSettings(defaults: d).sideWeb == "off")
        #expect(AppSettings.engineSettings(defaults: d).sideAllowWeb == false)
        d.set("rules", forKey: AppSettings.Key.sideWeb)
        #expect(AppSettings.engineSettings(defaults: d).sideWeb == "rules")
        d.set("on", forKey: AppSettings.Key.sideWeb)
        #expect(AppSettings.engineSettings(defaults: d).sideAllowWeb == true)
        d.set("everything", forKey: AppSettings.Key.sideWeb)
        #expect(AppSettings.sideWeb(defaults: d) == .off)
        #expect(SideWebMode.on.help.isEmpty == false)
    }

    @Test func forkPointAndRefork() throws {
        let th = try thread()
        #expect(SideTrust.forkPointLabel(th) != nil)
        #expect(SideTrust.forkIsBehind(th, turnCount: 5))
        #expect(!SideTrust.forkIsBehind(th, turnCount: 3))
        #expect(SideTrust.forkPointLabel(try thread(fork: #"{"mode":"fresh","fromSessionId":null,"at":null,"atTurn":null,"runningTurn":1}"#)) == nil)
        #expect(SideTrust.reforkQuestion(th, typed: "  지금은?  ") == "지금은?")
        #expect(SideTrust.reforkQuestion(th, typed: "") == "이 매퍼 왜 바꿨어?")
        let cmd = try json(.sideRefork(threadId: "th1", question: "지금은?"))
        #expect(cmd["type"] as? String == "side_ask")
        #expect(cmd["threadId"] as? String == "th1")
        #expect(cmd["question"] as? String == "지금은?")
        #expect(cmd["refork"] as? Bool == true)
    }

    @Test func quoteAnchorsRoundTrip() throws {
        let a = try #require(SideTrust.quoteAnchor("  N+1 때문이에요.\n", turn: 4))
        #expect(a.quote == SideQuoteAnchor(text: "N+1 때문이에요.", turn: 4))
        #expect(!a.isEmpty)
        #expect(SideTrust.quoteAnchor(" \n ", turn: 2) == nil)
        #expect(SideTrust.quoteAnchor(String(repeating: "y", count: SideTrust.quoteMax + 5), turn: 1)?.quote?.text.count == SideTrust.quoteMax)
        let cmd = try json(.sideAsk(anchor: a, question: "왜?"))
        let anchor = try #require(cmd["anchor"] as? [String: Any])
        let quote = try #require(anchor["quote"] as? [String: Any])
        #expect(quote["text"] as? String == "N+1 때문이에요.")
        #expect(quote["turn"] as? Int == 4)
        let back = try thread(anchor: #"{"quote":{"text":"매퍼를 바꿨어요","turn":4}}"#)
        #expect(back.anchor?.quote?.turn == 4)
        #expect(SideQuestionText.chip(back.anchor) == SideTrust.quoteLabel(SideQuoteAnchor(text: "x", turn: 4)))
        #expect(SideTrust.quoteTitle(SideQuoteAnchor(text: "매퍼를\n바꿨어요", turn: nil)) == "“매퍼를 바꿨어요”")
    }

    @Test func queuedConclusionIsRecorded() throws {
        let th = try thread(promotions: #"[{"as":"message","at":"t","queued":true}]"#)
        #expect(th.promotions.last?.queued == true)
        #expect(SideQuestionText.promotionLabel(try #require(th.promotions.last)).hasPrefix("⏳"))
        let old = try thread(promotions: #"[{"as":"message","at":"t"}]"#)
        #expect(old.promotions.last?.queued == false)
        let cmd = try json(.sidePromoteQueued(threadId: "th1", text: "가드 추가"))
        #expect(cmd["type"] as? String == "side_promote")
        #expect(cmd["as"] as? String == "message")
        #expect(cmd["queued"] as? Bool == true)
    }

    @Test func switchWarningAndModels() {
        #expect(SideTrust.switchWarning(runningCount: 0) == nil)
        #expect(SideTrust.switchWarning(runningCount: 2) != nil)
        let models = [ModelOption(value: "haiku", displayName: "Haiku", description: ""), ModelOption(value: "sonnet", displayName: "Sonnet", description: "")]
        #expect(SideTrust.modelChoices(models, current: "claude-opus-5-5").map(\.value) == ["", "haiku", "sonnet", "claude-opus-5-5"])
        #expect(SideTrust.modelChoices([], current: nil).map(\.value) == [""])
    }

    @Test func aChatSwitchAsksWhileASideAnswerRuns() async throws {
        let state = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        var sent: [EngineCommand] = []
        state.commandSink = { sent.append($0) }
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        state.handle(.state(s))
        var answer = false
        var asked: [String] = []
        state.confirmSideSwitch = { asked.append($0); return answer }
        // Nothing running: no question.
        #expect(await state.newChat())
        #expect(asked.isEmpty)
        state.side.upsert(try JSONDecoder().decode(SideThread.self, from: Data(#"{"id":"r1","mainSessionId":"chat-1","anchor":null,"createdAt":"","updatedAt":"","title":"q","messages":[],"status":"running","error":null,"sessionId":null,"fork":null,"costUSD":0}"#.utf8)))
        let before = sent.count
        #expect(await state.newChat() == false)
        #expect(asked.count == 1)
        #expect(sent.count == before)
        answer = true
        #expect(await state.newChat())
        #expect(sent.count == before + 1)
    }
}
