import Foundation

// MARK: §70.4 — docs/PROTOCOL.md §70.4: ⌥T turns extended thinking on or off for the chat, as Option+T / Alt+T in Claude
// Code. The wire (`state.session.thinking`, `set_thinking`), the words and the store's action; the composer bar shows it.

/// §70.4 `state.session.thinking`.
public struct ThinkingState: Codable, Sendable, Equatable, Hashable {
    /// The chat's choice: on unless ⌥T turned it off.
    public var enabled: Bool
    /// The model of the next answer always thinks (Opus / Sonnet / Haiku 5.5, Fable): ⌥T has no effect there.
    public var alwaysOn: Bool

    public init(enabled: Bool = true, alwaysOn: Bool = false) {
        self.enabled = enabled
        self.alwaysOn = alwaysOn
    }

    private enum CodingKeys: String, CodingKey { case enabled, alwaysOn }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = lenientValue(Bool.self, c, .enabled) ?? true
        alwaysOn = lenientValue(Bool.self, c, .alwaysOn) ?? false
    }

    /// Claude thinks for the next answer (the choice, or the model's own).
    public var thinks: Bool { enabled || alwaysOn }
}

/// `state.session.thinking` (lenient: missing or malformed → nil, an engine without §70.4).
enum ThinkingWire {
    private enum SessionKeys: String, CodingKey { case thinking }

    static func session(from decoder: Decoder) -> ThinkingState? {
        guard let c = try? decoder.container(keyedBy: SessionKeys.self) else { return nil }
        return lenientValue(ThinkingState.self, c, .thinking)
    }
}

extension EngineCommand {
    private enum ThinkingKeys: String, CodingKey { case enabled }

    /// `set_thinking {enabled}` (`type` is written by the caller).
    func encodeThinkingFields(to encoder: Encoder) throws {
        guard case let .setThinking(enabled) = self else { return }
        var c = encoder.container(keyedBy: ThinkingKeys.self)
        try c.encode(enabled, forKey: .enabled)
    }
}

/// §70.4: the composer bar's words.
public enum ThinkingText {
    /// The chip: "Thinking" with the state.
    public static func chip(_ state: ThinkingState) -> String {
        state.thinks ? String(localized: "Thinking on", bundle: .module) : String(localized: "Thinking off", bundle: .module)
    }

    /// The chip's tooltip (the shortcut, and what it does for this model).
    public static func help(_ state: ThinkingState) -> String {
        if state.alwaysOn {
            return String(localized: "This model always uses extended thinking — ⌥T has no effect on it", bundle: .module)
        }
        return state.enabled
            ? String(localized: "Extended thinking is on for this chat — click or press ⌥T to turn it off", bundle: .module)
            : String(localized: "Extended thinking is off for this chat — click or press ⌥T to turn it on", bundle: .module)
    }

    /// The line the composer shows after a toggle, as the terminal does.
    public static func toggled(_ on: Bool) -> String {
        on ? String(localized: "Thinking on — from Claude's next request", bundle: .module)
           : String(localized: "Thinking off — from Claude's next request", bundle: .module)
    }

    /// The engine's refusals of `set_thinking` in the user's words.
    public static func refusal(code: String, detail: String) -> String? {
        switch code {
        case "invalid_thinking": return String(localized: "Could not change thinking — the app sent something the engine does not take", bundle: .module)
        case "set_thinking_failed":
            return detail.isEmpty ? String(localized: "Claude Code could not change thinking", bundle: .module)
                                  : String(localized: "Claude Code could not change thinking: \(detail)", bundle: .module)
        default: return nil
        }
    }
}

public extension AppState {
    /// §70.4: the chat's extended thinking; nil from an engine without it.
    var thinking: ThinkingState? { sessionInfo.thinking }

    /// Why ⌥T and the chip do nothing now; nil: they work. A model that always thinks is not a blocker (the chip says so).
    var thinkingBlocker: String? {
        guard projectInfo != nil else { return EngineMessages.refusal(error: "no_project") }
        guard thinking != nil else { return String(localized: "This engine cannot change thinking — update ReviewGate", bundle: .module) }
        if isTerminalChat { return String(localized: "A terminal chat has its own ⌥T", bundle: .module) }
        if viewingChat != nil { return String(localized: "Go back to the running chat to change thinking", bundle: .module) }
        return nil
    }

    /// §70.4 `set_thinking {enabled}`: nil when it took, else why not.
    func setThinking(_ enabled: Bool) async -> String? {
        do {
            try await request(.setThinking(enabled: enabled))
            return nil
        } catch {
            appendLog("[warn] set_thinking: \(error.localizedDescription)")
            return (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        }
    }

    /// ⌥T: the other state. A model that always thinks keeps the choice as it is — the terminal's toggle has no effect there.
    func toggleThinking() async -> ThinkingToggle {
        if let blocker = thinkingBlocker { return .refused(blocker) }
        guard let state = thinking else { return .refused(thinkingBlocker ?? "") }
        if state.alwaysOn { return .alwaysOn }
        if let why = await setThinking(!state.enabled) { return .refused(why) }
        return .changed(!state.enabled)
    }
}

/// §70.4: what ⌥T did — the composer's line says it.
public enum ThinkingToggle: Equatable, Sendable {
    case changed(Bool)
    case alwaysOn
    case refused(String)

    /// The composer's line; `warning` — a refusal.
    public var notice: (text: String, warning: Bool) {
        switch self {
        case let .changed(on): (ThinkingText.toggled(on), false)
        case .alwaysOn: (ThinkingText.help(ThinkingState(enabled: true, alwaysOn: true)), false)
        case let .refused(why): (why, true)
        }
    }
}
