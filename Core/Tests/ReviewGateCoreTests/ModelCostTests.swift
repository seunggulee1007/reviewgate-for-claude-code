import Foundation
import Testing
@testable import ReviewGateCore

/// wave4d w4d-agents2: docs/PROTOCOL.md §42.4 — the per-model cost fields read leniently, and the display rule Electron's
/// agentCost.test.ts checks with the same fixture (engine/test/fixtures/modelCosts.json).
@Suite struct ModelCostTests {
    private static let repo: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // Tests/ReviewGateCoreTests/<file> → repo root
        return url
    }()

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test func sharesMatchTheEngineFixture() throws {
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("engine/test/fixtures/modelCosts.json"))
        let root = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let cases = try #require(root["cases"] as? [[String: Any]])
        #expect(cases.count >= 3)
        for c in cases {
            let modelsData = try JSONSerialization.data(withJSONObject: c["models"] ?? [])
            let models = try JSONDecoder().decode([ModelCost].self, from: modelsData)
            let got = ModelCostText.shares(models)
            let want = try #require(c["shares"] as? [[String: Any]])
            #expect(got.count == want.count)
            for (g, w) in zip(got, want) {
                #expect(g.key == w["key"] as? String)
                #expect(g.label == w["label"] as? String)
                #expect(g.family.rawValue == w["family"] as? String)
                #expect(abs(g.costUsd - (w["costUsd"] as? Double ?? -1)) < 1e-9)
                #expect(Int((g.fraction * 100).rounded()) == w["percent"] as? Int)
                #expect(g.models == w["models"] as? [String])
            }
            #expect(ModelCostText.line(got) == c["line"] as? String)
        }
    }

    @Test func fieldsAreLenient() throws {
        let usage = try decode(Usage.self, #"{"inputTokens":1,"outputTokens":2,"costUsd":0.4,"durationMs":5,"models":[{"model":"claude-opus-4-1","costUsd":0.38,"inputTokens":"x"},{"costUsd":1},7,{"model":"claude-haiku-4-5","costUsd":0.02,"cacheReadTokens":1200}]}"#)
        #expect(usage.models == [ModelCost(model: "claude-opus-4-1", costUsd: 0.38), ModelCost(model: "claude-haiku-4-5", costUsd: 0.02, cacheReadTokens: 1200)])
        #expect(try decode(Usage.self, #"{"costUsd":0.1,"models":"x"}"#).models.isEmpty)
        let summary = try decode(TurnSummary.self, #"{"turn":3,"files":[],"commands":[],"plan":null,"models":[{"model":"claude-sonnet-4-5","costUsd":0.06}]}"#)
        #expect(summary.models.map(\.model) == ["claude-sonnet-4-5"])
        #expect(try decode(TurnSummary.self, #"{"turn":3,"files":[],"commands":[]}"#).models.isEmpty)
        let hud = try decode(HUDWire.self, #"{"contextTokens":0,"sessionCostUSD":0.4,"turnCount":1,"lastTurnMs":5,"activity":{"kind":"idle"},"subagentDepth":0,"agents":[],"turnModels":[{"model":"claude-opus-4-1","costUsd":0.38}],"sessionModels":[{"model":"claude-opus-4-1","costUsd":0.5}]}"#)
        #expect(hud.turnModels.map(\.costUsd) == [0.38])
        #expect(hud.sessionModels.map(\.costUsd) == [0.5])
        let older = try decode(HUDWire.self, #"{"contextTokens":0,"sessionCostUSD":0,"turnCount":0,"lastTurnMs":0,"activity":{"kind":"idle"},"subagentDepth":0}"#)
        #expect(older.turnModels.isEmpty && older.sessionModels.isEmpty)
    }

    @Test func agentModelPrefersTheModelItRanOn() throws {
        let named = try decode(AgentNode.self, #"{"id":"t1","toolUseId":"ag1","type":"executor","status":"running","files":[],"model":"opus"}"#)
        #expect(named.apiModel == nil)
        #expect(ModelCostText.agentModel(named) == "opus")
        let ran = try decode(AgentNode.self, #"{"id":"t1","toolUseId":"ag1","type":"executor","status":"running","files":[],"model":null,"apiModel":"claude-sonnet-4-5-20250929"}"#)
        #expect(ModelCostText.agentModel(ran) == "claude-sonnet-4-5-20250929")
        let odd = try decode(AgentNode.self, #"{"id":"t1","toolUseId":"ag1","status":"running","files":[],"apiModel":7}"#)
        #expect(ModelCostText.agentModel(odd) == nil)
    }

    @Test func usdFormat() {
        #expect(ModelCostText.usd(0.38) == "$0.38")
        #expect(ModelCostText.usd(0.004) == "<$0.01")
        #expect(ModelCostText.usd(0) == "$0.00")
        #expect(ModelCostText.usd(1.234) == "$1.23")
    }
}
