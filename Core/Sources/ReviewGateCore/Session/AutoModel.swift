import Foundation

// MARK: wave5 w5-model
// docs/PROTOCOL.md §43.4 auto model, client side: the words for a turn's model (the chat's faint switch line, the turn
// summary, the chip and its hover, the cost popover's counts), the setting (`AppSettings.modelMode` / `autoModelPolicy`,
// pushed with `hello` and `set_settings`) and the composer's one-message model. Electron: renderer/autoModel.ts (same words).

public enum AutoModelText {
    /// The reason in words ("설계 판단"); an unknown code reads as itself.
    public static func reason(_ code: String) -> String {
        switch code {
        case "plan_mode": String(localized: "planning", bundle: .module)
        case "plan_implementation": String(localized: "implementing the approved plan", bundle: .module)
        case "after_failure": String(localized: "retry after a failed turn", bundle: .module)
        case "after_revert": String(localized: "retry after a revert", bundle: .module)
        case "changes_requested": String(localized: "changes requested", bundle: .module)
        case "design": String(localized: "design decision", bundle: .module)
        case "debug": String(localized: "root-cause analysis", bundle: .module)
        case "refactor": String(localized: "refactoring", bundle: .module)
        case "why": String(localized: "a “why” question", bundle: .module)
        case "wide_scope": String(localized: "wide scope", bundle: .module)
        case "long_message": String(localized: "long request", bundle: .module)
        case "attachments": String(localized: "many attachments", bundle: .module)
        case "quality_policy": String(localized: "quality first", bundle: .module)
        case "trivial_edit": String(localized: "small fix", bundle: .module)
        case "quick_question": String(localized: "short question", bundle: .module)
        case "short_message": String(localized: "short request", bundle: .module)
        case "standard": String(localized: "everyday work", bundle: .module)
        case "cost_policy": String(localized: "cost first", bundle: .module)
        case "simple_task": String(localized: "simple request", bundle: .module)
        case "continuation": String(localized: "continuing", bundle: .module)
        case "user_choice": String(localized: "your pick for this message", bundle: .module)
        case "manual": String(localized: "back to your model", bundle: .module)
        default: code
        }
    }

    /// The model's short name: the family ("opus"), else the id as the HUD shows it, else "기본 모델".
    public static func modelName(_ choice: AutoModelChoice) -> String {
        if let family = choice.family, !family.isEmpty { return family }
        guard let model = choice.model, !model.isEmpty else { return String(localized: "Default model", bundle: .module) }
        let family = AgentModelText.family(model)
        return family == .other ? AgentModelText.label(model) : family.rawValue
    }

    /// The chat's faint line when the model changed before a message ("모델을 opus 로 바꿨어요 — 설계 판단"); nil otherwise.
    public static func switchLine(_ choice: AutoModelChoice?) -> String? {
        guard let choice, choice.switched else { return nil }
        return String(localized: "Switched the model to \(modelName(choice)) — \(reason(choice.reason))", bundle: .module)
    }

    /// The turn summary's line: "모델: opus (자동 · 설계 판단)".
    public static func summaryLine(_ choice: AutoModelChoice) -> String {
        let why = choice.by == .auto ? String(localized: "Auto · \(reason(choice.reason))", bundle: .module) : reason(choice.reason)
        return String(localized: "Model: \(modelName(choice)) (\(why))", bundle: .module)
    }

    /// The chip in auto mode: "자동 · sonnet", "자동" before the first message.
    public static func chipText(_ choice: AutoModelChoice?) -> String {
        guard let choice, choice.by == .auto else { return String(localized: "Auto", bundle: .module) }
        return String(localized: "Auto · \(modelName(choice))", bundle: .module)
    }

    /// The chip's hover in auto mode: the last pick and why.
    public static func chipHelp(_ choice: AutoModelChoice?, policy: AutoModelPolicy) -> String {
        guard let choice, choice.by == .auto else {
            return String(localized: "Auto picks the model for each message (\(policy.displayName))", bundle: .module)
        }
        return String(localized: "Auto picked \(modelName(choice)) — \(reason(choice.reason)) (\(policy.displayName))", bundle: .module)
    }

    /// The cost popover's line: "opus 3 · sonnet 5 · haiku 2" (nil without counts).
    public static func countsLine(_ counts: [AutoModelCount]) -> String? {
        let parts = counts.filter { $0.count > 0 }.map { "\($0.family) \($0.count)" }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The composer's one-message pick: "이번엔 opus".
    public static func nextMessageLabel(_ model: String) -> String {
        let family = AgentModelText.family(model)
        let name = family == .other ? AgentModelText.label(model) : family.rawValue
        return String(localized: "This time \(name)", bundle: .module)
    }

    // Labels of the chip menu, the composer's one-message menu and the cost popover (both apps).
    public static var menuAutoTitle: String { String(localized: "Auto", bundle: .module) }
    public static var menuAutoDetail: String { String(localized: "Picks opus, sonnet or haiku for each message before it goes out", bundle: .module) }
    public static var menuAutoNote: String { String(localized: "Every switch shows as a faint line in the chat. A running turn keeps its model.", bundle: .module) }
    public static var nextMessageTitle: String { String(localized: "Model for this message", bundle: .module) }
    public static var nextMessageNone: String { String(localized: "As usual (auto or your model)", bundle: .module) }
    public static var nextMessageHelp: String { String(localized: "Only the next message goes out on the model you pick here", bundle: .module) }
    public static var countsTitle: String { String(localized: "Auto picks in this session", bundle: .module) }

    /// The families the composer offers for one message: the option value of each (newest of the family, as the engine
    /// picks), in opus / sonnet / haiku order; families the session does not offer are left out.
    public static func oneMessageOptions(_ models: [ModelOption]) -> [(family: String, value: String)] {
        ["opus", "sonnet", "haiku"].compactMap { family -> (String, String)? in
            let of = models.filter { $0.value != "default" && (AgentModelText.family($0.value).rawValue == family || AgentModelText.family($0.resolvedModel ?? "").rawValue == family) }
            let plain = of.filter { !$0.value.contains("[") }
            guard let best = (plain.isEmpty ? of : plain).max(by: { version($0) < version($1) }) else { return nil }
            return (family, best.value)
        }
    }

    /// major * 1000 + minor of an option (a bare alias without a resolved id counts as the newest).
    private static func version(_ option: ModelOption) -> Int {
        let id = option.resolvedModel ?? option.value
        if option.resolvedModel == nil, ["opus", "sonnet", "haiku"].contains(option.value.lowercased()) { return Int.max }
        var s = id
        if let bracket = s.firstIndex(of: "[") { s = String(s[..<bracket]) }
        if let range = s.range(of: #"-\d{8}$"#, options: .regularExpression) { s.removeSubrange(range) }
        let numbers = s.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
        guard let major = numbers.first else { return -1 }
        return major * 1000 + (numbers.dropFirst().first ?? 0)
    }
}

// MARK: - Settings

public extension AppSettings {
    /// §43.4: `ModelMode.rawValue` (unset → manual) and `AutoModelPolicy.rawValue` (unset → balanced).
    static let modelModeKey = "modelMode"
    static let autoModelPolicyKey = "modelAutoPolicy"

    static func modelMode(defaults: UserDefaults = .standard) -> ModelMode {
        defaults.string(forKey: modelModeKey).flatMap(ModelMode.init(rawValue:)) ?? .manual
    }

    static func autoModelPolicy(defaults: UserDefaults = .standard) -> AutoModelPolicy {
        defaults.string(forKey: autoModelPolicyKey).flatMap(AutoModelPolicy.init(rawValue:)) ?? .balanced
    }

    static func setModelMode(_ mode: ModelMode, policy: AutoModelPolicy? = nil, defaults: UserDefaults = .standard) {
        defaults.set(mode.rawValue, forKey: modelModeKey)
        if let policy { defaults.set(policy.rawValue, forKey: autoModelPolicyKey) }
    }
}

public extension UserMessageMeta {
    init(turn: Int, mentions: [String], attachments: [AttachmentRef], autoModel: AutoModelChoice?) {
        self.init(turn: turn, mentions: mentions, attachments: attachments)
        self.autoModel = autoModel
    }
}

public extension QueuedMessage {
    /// `send`, or `send` with this message's own model (§43.4).
    func sendCommand(acceptPending: Bool) -> EngineCommand {
        let attachments = images.map(\.sendAttachment)
        if let model { return .sendWithModel(text: text, acceptPending: acceptPending, mentions: mentions, attachments: attachments, model: model) }
        return .send(text: text, acceptPending: acceptPending, mentions: mentions, attachments: attachments)
    }
}

// MARK: - AppState

public extension AppState {
    /// This window's model mode / policy (Settings, shared by every window; the chip re-reads them on a change).
    var modelMode: ModelMode {
        _ = autoModelSettingsRevision
        return AppSettings.modelMode(defaults: settingsDefaults)
    }

    var autoModelPolicy: AutoModelPolicy {
        _ = autoModelSettingsRevision
        return AppSettings.autoModelPolicy(defaults: settingsDefaults)
    }

    /// The model the running / last turn was given (§43.4).
    var autoModel: AutoModelChoice? { sessionInfo.autoModel }

    /// The HUD chip in auto mode ("자동 · sonnet"); nil in manual mode (the chip shows the chosen model).
    var autoModelChipText: String? {
        modelMode == .auto ? AutoModelText.chipText(autoModel) : nil
    }

    /// The chip menu's "자동": stores the mode (every window reads it) and tells this window's engine; the policy too.
    func setModelMode(_ mode: ModelMode, policy: AutoModelPolicy? = nil) {
        AppSettings.setModelMode(mode, policy: policy, defaults: settingsDefaults)
        pushModelMode()
    }

    /// `set_settings {modelMode, modelAutoPolicy}` as stored (live: the next message follows it).
    func pushModelMode() {
        autoModelSettingsRevision += 1
        guard state.seq > 0 || commandSink != nil else { return }
        var settings = EngineSettings()
        settings.modelMode = AppSettings.modelMode(defaults: settingsDefaults).rawValue
        settings.modelAutoPolicy = AppSettings.autoModelPolicy(defaults: settingsDefaults).rawValue
        fire(.setSettings(settings))
    }

    /// The composer's "이번엔 opus": only the next message goes out on `model` (nil clears it).
    func setNextMessageModel(_ model: String?) {
        nextMessageModel = model
    }

    /// The message with the composer's one-message model attached (the pick is used up).
    internal func withNextMessageModel(_ message: QueuedMessage) -> QueuedMessage {
        guard let model = nextMessageModel else { return message }
        nextMessageModel = nil
        var out = message
        out.model = model
        return out
    }
}
