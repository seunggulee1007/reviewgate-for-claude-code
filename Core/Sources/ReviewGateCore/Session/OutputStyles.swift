import Foundation

// MARK: §72.2 — docs/PROTOCOL.md §72.2: `/output-style [style]` in a classic chat, as in Claude Code: the styles the
// session offers, the current one, and a switch through the CLI's own settings writer (`.claude/settings.local.json`,
// live from the next message). The wire, the words and the store's actions.

/// §72.2 one output style.
public struct OutputStyleInfo: Sendable, Equatable, Decodable, Identifiable {
    public enum Source: String, Sendable, Equatable { case builtin, user, project, plugin, managed, other }

    public var name: String
    /// A style file's description; nil for a built-in (its words are `OutputStyleText.builtinDescription`).
    public var description: String?
    public var source: Source
    public var path: String?
    public var plugin: String?

    public var id: String { name }

    public init(name: String, description: String? = nil, source: Source, path: String? = nil, plugin: String? = nil) {
        self.name = name
        self.description = description
        self.source = source
        self.path = path
        self.plugin = plugin
    }

    private enum CodingKeys: String, CodingKey { case name, description, source, path, plugin }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        description = lenientValue(String.self, c, .description)
        source = lenientValue(String.self, c, .source).flatMap(Source.init(rawValue:)) ?? .other
        path = lenientValue(String.self, c, .path)
        plugin = lenientValue(String.self, c, .plugin)
    }
}

/// §72.2 the settings file whose `outputStyle` applies.
public struct OutputStyleSetIn: Sendable, Equatable, Decodable {
    public var source: String
    public var path: String
    public var value: String

    public init(source: String, path: String, value: String) {
        self.source = source
        self.path = path
        self.value = value
    }
}

/// §72.2 reply to `output_styles` / `output_style_set`.
public struct OutputStylesReply: Sendable, Equatable, Decodable {
    public var styles: [OutputStyleInfo]
    /// The session's style ("default" without one); nil before the session said.
    public var current: String?
    public var setIn: OutputStyleSetIn?
    public var canSet: Bool
    /// `no_session`, `local_settings_off`, `unsupported` — why `canSet` is false.
    public var why: String?

    public init(styles: [OutputStyleInfo], current: String?, setIn: OutputStyleSetIn? = nil, canSet: Bool, why: String? = nil) {
        self.styles = styles
        self.current = current
        self.setIn = setIn
        self.canSet = canSet
        self.why = why
    }

    private enum CodingKeys: String, CodingKey { case styles, current, setIn, canSet, why }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        styles = lenientElements(OutputStyleInfo.self, c, .styles)
        current = lenientValue(String.self, c, .current)
        setIn = lenientValue(OutputStyleSetIn.self, c, .setIn)
        canSet = lenientValue(Bool.self, c, .canSet) ?? false
        why = lenientValue(String.self, c, .why)
    }

    /// Why `name` cannot be picked now; nil when it can.
    public func blocker(for name: String) -> String? {
        if !canSet { return OutputStyleText.why(why) }
        if let current, current.caseInsensitiveCompare(name) == .orderedSame { return OutputStyleText.isCurrent }
        return nil
    }
}

/// `state.session.outputStyle` (nil: absent — an older engine — or null — no session said yet).
enum OutputStyleWire {
    private enum Keys: String, CodingKey { case outputStyle }

    static func session(from decoder: Decoder) -> String? {
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return nil }
        return lenientValue(String.self, c, .outputStyle)
    }
}

/// §72.2: the words of `/output-style`, its sheet and the composer's mode menu.
public enum OutputStyleText {
    public static var description: String { String(localized: "Choose how Claude answers — the output style, as the terminal's /output-style", bundle: .module) }
    public static var title: String { String(localized: "Output Style", bundle: .module) }
    public static var subtitle: String {
        String(localized: "Claude uses the new style from your next message. It is saved to .claude/settings.local.json, as the terminal's /output-style saves it.", bundle: .module)
    }
    public static var useButton: String { String(localized: "Use Style", bundle: .module) }
    public static var current: String { String(localized: "Current", bundle: .module) }
    public static var isCurrent: String { String(localized: "This is the current style", bundle: .module) }
    public static var loading: String { String(localized: "Reading the output styles…", bundle: .module) }
    public static var argumentHint: String { "[style]" }

    /// The name as the list shows it ("default" reads "Default").
    public static func displayName(_ name: String) -> String {
        name.caseInsensitiveCompare("default") == .orderedSame ? String(localized: "Default", bundle: .module) : name
    }

    /// A built-in's line (the output-styles page's table); nil for any other name.
    public static func builtinDescription(_ name: String) -> String? {
        switch name.lowercased() {
        case "default": String(localized: "Claude Code's standard instructions for software engineering", bundle: .module)
        case "proactive": String(localized: "Starts work right away and makes reasonable assumptions instead of asking about routine decisions", bundle: .module)
        case "concise": String(localized: "Leads with the result and leaves out the preamble, the narration and the recap", bundle: .module)
        case "explanatory": String(localized: "Adds short Insight blocks that explain the choices behind the code", bundle: .module)
        case "learning": String(localized: "Explains its choices and leaves small pieces of code for you to write", bundle: .module)
        default: nil
        }
    }

    public static func description(of style: OutputStyleInfo) -> String? {
        style.source == .builtin ? builtinDescription(style.name) : style.description
    }

    public static func source(_ style: OutputStyleInfo) -> String {
        switch style.source {
        case .builtin: String(localized: "Built-in style", bundle: .module)
        case .user: String(localized: "User", bundle: .module)
        case .project: String(localized: "Project", bundle: .module)
        case .plugin: style.plugin.map { String(localized: "Plugin \($0)", bundle: .module) } ?? String(localized: "Plugin", bundle: .module)
        case .managed: String(localized: "Managed policy", bundle: .module)
        case .other: String(localized: "Claude Code", bundle: .module)
        }
    }

    /// Where the style that applies is set; nil without a settings value.
    public static func setIn(_ s: OutputStyleSetIn?) -> String? {
        guard let s else { return nil }
        if s.source == "managed" { return String(localized: "Your organization's policy sets the style (\(s.value))", bundle: .module) }
        return String(localized: "\(s.value) is set in \(SessionNotices.abbreviatingHome(s.path))", bundle: .module)
    }

    /// Why the style cannot be switched now.
    public static func why(_ why: String?) -> String {
        switch why {
        case "local_settings_off":
            String(localized: "This project's chats do not load .claude/settings.local.json (Settings › Extensions), where the style is saved", bundle: .module)
        case "unsupported":
            String(localized: "This Claude Code cannot switch the style from the app — update it, or use a terminal chat", bundle: .module)
        default:
            String(localized: "The output style can be changed once the session has started", bundle: .module)
        }
    }

    public static func switched(_ name: String) -> String {
        String(localized: "Output style: \(displayName(name)) — Claude uses it from your next message", bundle: .module)
    }

    /// The composer's mode menu: its item and the line in its tooltip.
    public static func menuItem(_ name: String) -> String { String(localized: "Output Style: \(displayName(name))…", bundle: .module) }
    public static func helpLine(_ name: String) -> String { String(localized: "Output style: \(displayName(name)) (/output-style)", bundle: .module) }

    /// The engine's refusals of `output_style_set` in the user's words.
    public static func refusal(code: String, detail: String) -> String? {
        switch code {
        case "unknown_output_style": String(localized: "No output style is called “\(detail)” — type /output-style to see the list", bundle: .module)
        case "invalid_output_style": String(localized: "Type a style after /output-style — /output-style concise", bundle: .module)
        case "local_settings_off": why("local_settings_off")
        case "output_style_unsupported": why("unsupported")
        case "output_style_failed": String(localized: "Claude Code could not switch the style: \(detail)", bundle: .module)
        default: nil
        }
    }
}

extension EngineCommand {
    private enum OutputStyleKeys: String, CodingKey { case name }

    /// `output_style_set {name}` (`type` is written by the caller).
    func encodeOutputStyleFields(to encoder: Encoder) throws {
        guard case let .outputStyleSet(name) = self else { return }
        var c = encoder.container(keyedBy: OutputStyleKeys.self)
        try c.encode(name, forKey: .name)
    }
}

public extension AppState {
    /// §72.2: the running session's output style (nil before it said, or from an engine without §72.2).
    var outputStyle: String? { sessionInfo.outputStyle }

    /// §72.2 `output_styles`. Throws the engine's refusal.
    func outputStyles() async throws -> OutputStylesReply {
        if let debugOutputStyles { return debugOutputStyles }   // the screenshot tour
        let reply = try await reply(.outputStyles)
        guard case let .outputStyles(styles) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return styles
    }

    /// §72.2 `output_style_set {name}` (any case). Throws the engine's refusal.
    func setOutputStyle(_ name: String) async throws -> OutputStylesReply {
        let reply = try await reply(.outputStyleSet(name: name))
        guard case let .outputStyles(styles) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return styles
    }
}
