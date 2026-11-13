import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §56.1 on the Mac: `/btw <question>` is the app's command — asked on the side (`btw_ask`), the answer in an
/// overlay over the message box, `/btw` alone shows it again. Electron: btw.test.ts.
@Suite @MainActor struct BtwTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "BtwTests.\(UUID().uuidString)")!)
    }

    @Test func whatIsTheBtwCommand() {
        #expect(BtwCommand.question(in: "/btw what does sum() return?") == "what does sum() return?")
        #expect(BtwCommand.question(in: "  /BTW   why?\n") == "why?")
        #expect(BtwCommand.question(in: "/btw") == "")
        #expect(BtwCommand.question(in: "/btw   ") == "")
        #expect(BtwCommand.question(in: "/btw\nmulti\nline") == "multi\nline")
        #expect(BtwCommand.question(in: "/btwx no") == nil)
        #expect(BtwCommand.question(in: "by the way /btw") == nil)
        #expect(BtwCommand.question(in: "/compact") == nil)
    }

    @Test func theWire() throws {
        let data = try JSONEncoder().encode(EngineCommandEnvelope(id: "c1", command: .btwAsk(question: "why?")))
        let sent = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(sent["type"] as? String == "btw_ask")
        #expect(sent["question"] as? String == "why?")
        let json = #"{"type":"btw_answer","id":"c1","question":"why?","answer":"Because.","via":"fork"}"#
        let event = try JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8))
        #expect(event == .btwAnswer(BtwAnswer(id: "c1", question: "why?", answer: "Because.", viaFork: true)))
        #expect(event.replyId == "c1")
        let session = try JSONDecoder().decode(EngineEvent.self, from: Data(#"{"type":"btw_answer","question":"q","answer":"a","via":"session","synthetic":true}"#.utf8))
        #expect(session == .btwAnswer(BtwAnswer(question: "q", answer: "a", viaFork: false, synthetic: true)))
    }

    @Test func theAnswerOpensOverTheBoxAndComesBackWithBtwAlone() async {
        let app = makeState()
        var asked: [EngineCommand] = []
        app.replySink = { command in
            asked.append(command)
            return .btwAnswer(BtwAnswer(question: "why?", answer: "Because."))
        }
        #expect(!app.showLastBtw())   // nothing yet
        await app.askBtw("  why?  ")
        #expect(asked == [.btwAsk(question: "why?")])
        #expect(app.btwOverlay == .answered(BtwAnswer(question: "why?", answer: "Because.")))
        app.dismissBtw()
        #expect(app.btwOverlay == nil)
        #expect(app.showLastBtw())
        #expect(app.btwOverlay == .answered(BtwAnswer(question: "why?", answer: "Because.")))
    }

    @Test func aRefusalSaysWhyAndGivesTheQuestionBack() async {
        let app = makeState()
        app.replySink = { _ in throw EngineClientError.refused("btw_failed:boom", code: "btw_failed") }
        await app.askBtw("why?")
        #expect(app.btwOverlay == nil)
        #expect(app.btwFailure?.question == "why?")
        #expect(app.btwFailure?.text == FlowText.refusal(code: "btw_failed", detail: "boom"))
        #expect(!app.showLastBtw())
    }

    @Test func cancelDropsTheAnswerWhenItComes() async {
        let app = makeState()
        let (gate, open) = AsyncStream<Void>.makeStream()
        app.replySink = { _ in
            for await _ in gate { break }
            return .btwAnswer(BtwAnswer(question: "slow", answer: "late"))
        }
        let asking = Task { await app.askBtw("slow") }
        while app.btwOverlay == nil { await Task.yield() }
        #expect(app.btwOverlay == .asking(question: "slow"))
        app.dismissBtw()
        open.yield()
        await asking.value
        #expect(app.btwOverlay == nil)
        #expect(!app.showLastBtw())
    }

    @Test func thePaletteListsBtw() {
        let caps = SessionCapabilities(slashCommands: ["compact"], skills: [], plugins: [], mcpServers: [])
        let btw = SlashCommandCatalog.entries(caps).first { $0.name == "btw" }
        #expect(btw?.description == BtwCommand.description)
        #expect(btw?.argumentHint == "<question>")
        #expect(btw?.group == .builtin)
        #expect(SlashCommandCatalog.entries(nil).isEmpty)
    }
}
