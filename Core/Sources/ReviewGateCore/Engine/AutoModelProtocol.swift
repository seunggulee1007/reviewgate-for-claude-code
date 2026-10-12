import Foundation

// MARK: wave5 w5-model
// Wire types of docs/PROTOCOL.md §43.4 (auto model): `settings.modelMode` / `modelAutoPolicy`, `send.model`, the model a
// turn was given (`state.session.autoModel`, `user_message.autoModel`, `turn_summary.autoModel`) and how often auto chose
// each family (`hud.autoModelCounts`); engine/src/protocol.ts "MARK: wave5 w5-model". Every field is lenient: an engine
// before §43.4 sends none of them and the screens look as before.

/// §43.4 `settings.modelMode`: the chip's model (`manual`, the default) or the engine's pick per message (`auto`).
public enum ModelMode: String, Sendable, CaseIterable, Codable {
    case manual, auto
}

/// §43.4 `settings.modelAutoPolicy`: how readily auto picks opus / haiku.
public enum AutoModelPolicy: String, Sendable, CaseIterable, Identifiable, Codable {
    case cost, balanced, quality

    public var id: String { rawValue }

    /// "비용 우선" / "균형" / "품질 우선".
    public var displayName: String {
        switch self {
        case .cost: String(localized: "Cost first", bundle: .module)
        case .balanced: String(localized: "Balanced", bundle: .module)
        case .quality: String(localized: "Quality first", bundle: .module)
        }
    }

    /// One line under the picker.
    public var detail: String {
        switch self {
        case .cost: String(localized: "haiku for simple requests, opus only for plans and the hardest work", bundle: .module)
        case .balanced: String(localized: "opus for design, debugging and big changes, haiku for tiny fixes", bundle: .module)
        case .quality: String(localized: "opus for everything but the simplest requests", bundle: .module)
        }
    }
}

/// §43.4: the model a turn was given before it went out. `by`: `auto`, `user` (this message's pick) or `manual` (the
/// chip's model again after a one-message pick); `switched` / `from`: the session was on another model before.
public struct AutoModelChoice: Sendable, Equatable, Hashable, Decodable {
    /// The option value sent to the CLI; nil = the CLI's default model.
    public var model: String?
    /// "opus" / "sonnet" / "haiku"; nil for another model.
    public var family: String?
    /// The engine's reason code (`design`, `trivial_edit`, …); an unknown one reads as itself.
    public var reason: String
    public var policy: AutoModelPolicy
    public var by: By
    public var switched: Bool
    public var from: String?

    public enum By: String, Sendable, Hashable, Decodable { case auto, user, manual }

    public init(model: String?, family: String? = nil, reason: String, policy: AutoModelPolicy = .balanced, by: By = .auto,
                switched: Bool = false, from: String? = nil) {
        self.model = model
        self.family = family
        self.reason = reason
        self.policy = policy
        self.by = by
        self.switched = switched
        self.from = from
    }

    private enum CodingKeys: String, CodingKey { case model, family, reason, policy, by, switched, from }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let reason = lenientValue(String.self, c, .reason), !reason.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .reason, in: c, debugDescription: "auto model without a reason")
        }
        self.init(model: lenientValue(String.self, c, .model),
                  family: lenientValue(String.self, c, .family),
                  reason: reason,
                  policy: lenientValue(String.self, c, .policy).flatMap(AutoModelPolicy.init(rawValue:)) ?? .balanced,
                  by: lenientValue(String.self, c, .by).flatMap(By.init(rawValue:)) ?? .auto,
                  switched: lenientValue(Bool.self, c, .switched) ?? false,
                  from: lenientValue(String.self, c, .from))
    }
}

/// §43.4 `hud.autoModelCounts`: messages auto sent to a family in this chat.
public struct AutoModelCount: Sendable, Equatable, Hashable, Decodable {
    public var family: String
    public var count: Int

    public init(family: String, count: Int) {
        self.family = family
        self.count = count
    }
}

enum AutoModelWire {
    private enum Keys: String, CodingKey { case autoModel, autoModelCounts }

    /// `autoModel` of a state's session, an event or a row (nil when absent or malformed).
    static func choice(from decoder: Decoder) -> AutoModelChoice? {
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return nil }
        return lenientValue(AutoModelChoice.self, c, .autoModel)
    }

    /// `hud.autoModelCounts` (entries that decode; [] from older engines).
    static func counts(from decoder: Decoder) -> [AutoModelCount] {
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return [] }
        return lenientElements(AutoModelCount.self, c, .autoModelCounts).filter { $0.count > 0 && !$0.family.isEmpty }
    }
}
