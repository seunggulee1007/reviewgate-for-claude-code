import Foundation

// MARK: wave4d w4d-agents2
// docs/PROTOCOL.md §42.4 — what each model cost, as both clients show it (Electron's agentCost.ts is the same rule; both
// are checked against engine/test/fixtures/modelCosts.json): the HUD's cost popover and the turn summary's bar
// "opus $0.38 · sonnet $0.06 · haiku $0.01", and the model chip on an agent card.

/// One bar segment: a model family's (or an unknown model's) cost in a turn.
public struct ModelCostShare: Sendable, Equatable, Identifiable {
    public var id: String { key }
    /// "opus" / "sonnet" / "haiku", else the model's own label.
    public var key: String
    public var label: String
    public var family: AgentModelFamily
    public var costUsd: Double
    /// Its share of the turn's cost (0…1).
    public var fraction: Double
    /// The model ids folded into it, in the order they came.
    public var models: [String]
    public var tokens: Int
}

public enum ModelCostText {
    /// The models of a turn grouped by family, most expensive first; what cost nothing is left out.
    public static func shares(_ models: [ModelCost]) -> [ModelCostShare] {
        var order: [String] = []
        var byKey: [String: ModelCostShare] = [:]
        for m in models where m.costUsd > 0 {
            let family = AgentModelText.family(m.model)
            let label = family == .other ? otherLabel(m.model) : family.rawValue
            if var had = byKey[label] {
                had.costUsd += m.costUsd
                had.tokens += m.totalTokens
                if !had.models.contains(m.model) { had.models.append(m.model) }
                byKey[label] = had
            } else {
                order.append(label)
                byKey[label] = ModelCostShare(key: label, label: label, family: family, costUsd: m.costUsd, fraction: 0, models: [m.model], tokens: m.totalTokens)
            }
        }
        let total = byKey.values.reduce(0) { $0 + $1.costUsd }
        return order.compactMap { byKey[$0] }
            .map { var s = $0; s.fraction = total > 0 ? s.costUsd / total : 0; return s }
            .sorted { $0.costUsd != $1.costUsd ? $0.costUsd > $1.costUsd : $0.label < $1.label }
    }

    /// "opus $0.38 · sonnet $0.06 · haiku $0.01" ("" for none).
    public static func line(_ shares: [ModelCostShare]) -> String {
        shares.map { "\($0.label) \(usd($0.costUsd))" }.joined(separator: " · ")
    }

    /// "$0.38"; under half a cent "<$0.01".
    public static func usd(_ v: Double) -> String {
        if v > 0, v < 0.005 { return "<$0.01" }
        return String(format: "$%.2f", v)
    }

    /// A model outside the three families: its id without `claude-` and the date (`claude-fable-1-20260101` → `fable-1`).
    static func otherLabel(_ model: String) -> String {
        var m = model.trimmingCharacters(in: .whitespaces)
        if m.lowercased().hasPrefix("claude-") { m = String(m.dropFirst("claude-".count)) }
        if let range = m.range(of: #"-\d{8}(?=$|\[)"#, options: .regularExpression) { m.removeSubrange(range) }
        return m
    }

    /// The model an agent card names: the one its answers came from (§42.4), else the one its call named (§36.1).
    public static func agentModel(_ node: AgentNode) -> String? {
        node.apiModel ?? node.model
    }
}
