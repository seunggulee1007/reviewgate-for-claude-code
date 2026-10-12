import Foundation

// MARK: wave4d w4d-agents2
// Wire types of docs/PROTOCOL.md §42.4 (subagent cost): what each model cost in a turn (`turn_end.usage.models`,
// `turn_summary.models`, `hud.turnModels` / `hud.sessionModels`) and the model a subagent's answers came from
// (`AgentNode.apiModel`); engine/src/protocol.ts, "MARK: wave4d w4d-agents2". Every field is lenient: an engine before
// §42.4 sends none of them and the screens look as before.

/// §42.4: one model's share of a turn (the CLI's estimate). `model`: the id as the CLI keyed it.
public struct ModelCost: Sendable, Equatable, Decodable {
    public var model: String
    public var costUsd: Double
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheCreationTokens: Int

    public init(model: String, costUsd: Double, inputTokens: Int = 0, outputTokens: Int = 0, cacheReadTokens: Int = 0, cacheCreationTokens: Int = 0) {
        self.model = model
        self.costUsd = costUsd
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreationTokens = cacheCreationTokens
    }

    private enum CodingKeys: String, CodingKey { case model, costUsd, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let model = AgentWire.nonEmpty(lenientValue(String.self, c, .model)) else {
            throw DecodingError.dataCorruptedError(forKey: .model, in: c, debugDescription: "model cost without a model")
        }
        func number(_ key: CodingKeys) -> Double {
            guard let v = lenientValue(Double.self, c, key), v.isFinite, v > 0 else { return 0 }
            return v
        }
        self.init(model: model, costUsd: number(.costUsd), inputTokens: Int(number(.inputTokens)), outputTokens: Int(number(.outputTokens)),
                  cacheReadTokens: Int(number(.cacheReadTokens)), cacheCreationTokens: Int(number(.cacheCreationTokens)))
    }

    /// Every token the model handled (input, output, cache reads and writes).
    public var totalTokens: Int { inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens }
}

enum AgentCostWire {
    private enum ModelsKeys: String, CodingKey { case models, turnModels, sessionModels, apiModel }

    /// `models` of a turn's usage / summary: the entries that decode; [] from older engines.
    static func models(from decoder: Decoder) -> [ModelCost] {
        guard let c = try? decoder.container(keyedBy: ModelsKeys.self) else { return [] }
        return lenientElements(ModelCost.self, c, .models)
    }

    /// `hud.turnModels` / `hud.sessionModels`.
    static func hud(from decoder: Decoder) -> (turn: [ModelCost], session: [ModelCost]) {
        guard let c = try? decoder.container(keyedBy: ModelsKeys.self) else { return ([], []) }
        return (lenientElements(ModelCost.self, c, .turnModels), lenientElements(ModelCost.self, c, .sessionModels))
    }

    /// `AgentNode.apiModel` (nil when absent, empty or not a string).
    static func apiModel(from decoder: Decoder) -> String? {
        guard let c = try? decoder.container(keyedBy: ModelsKeys.self) else { return nil }
        return AgentWire.nonEmpty(lenientValue(String.self, c, .apiModel))
    }
}
