import Foundation

// MARK: §70.3 — docs/PROTOCOL.md §70.3: `/export [file]` and `/copy [N]` in a classic chat, as in Claude Code. The engine
// makes the text from the chat's rows (`export_chat` → `chat_export`, `copy_response` → `response_text`); the app puts it
// on the clipboard or in a file the user picked. The wire, the words and the store's actions.

/// §70.3 `chat_export`: the conversation as plain text, the name a save panel proposes, and where it was written.
public struct ChatExport: Sendable, Equatable, Decodable {
    public var text: String
    public var name: String
    /// nil: not written (the app copies or saves it).
    public var path: String?

    public init(text: String, name: String, path: String? = nil) {
        self.text = text
        self.name = name
        self.path = path
    }

    private enum CodingKeys: String, CodingKey { case text, name, path }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        name = lenientValue(String.self, c, .name) ?? "conversation.txt"
        path = lenientValue(String.self, c, .path)
    }
}

/// §70.3 `response_text`: Claude's Nth-latest answer.
public struct ResponseText: Sendable, Equatable, Decodable {
    public var n: Int
    public var text: String

    public init(n: Int, text: String) {
        self.n = n
        self.text = text
    }

    private enum CodingKeys: String, CodingKey { case n, text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        n = lenientValue(Int.self, c, .n) ?? 1
    }
}

extension EngineCommand {
    private enum ExportKeys: String, CodingKey { case path, replace, n }

    /// `export_chat {path?, replace?}`, `copy_response {n?}` (`type` is written by the caller).
    func encodeExportFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: ExportKeys.self)
        switch self {
        case let .exportChat(path, replace):
            try c.encodeIfPresent(path, forKey: .path)
            if replace { try c.encode(true, forKey: .replace) }
        case let .copyResponse(n):
            try c.encodeIfPresent(n, forKey: .n)
        default: break
        }
    }
}

/// `/copy [N]`'s argument: "" → the latest (1); a whole number from 1; nil — not a number (the composer says how).
public enum CopyArgument {
    public static func parse(_ argument: String) -> Int? {
        let t = argument.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return 1 }
        guard let n = Int(t), n >= 1 else { return nil }
        return n
    }
}

/// §70.3: the words of `/export`, `/copy`, the export sheet and the refusals.
public enum ChatExportText {
    public static var exportDescription: String { String(localized: "Export the conversation as text — to the clipboard or a file", bundle: .module) }
    public static var copyDescription: String { String(localized: "Copy Claude's last answer — /copy 2 copies the one before", bundle: .module) }
    public static var sheetTitle: String { String(localized: "Export Conversation", bundle: .module) }
    public static var sheetMessage: String {
        String(localized: "The conversation as plain text, as the terminal's /export writes it", bundle: .module)
    }
    public static var copyButton: String { String(localized: "Copy to Clipboard", bundle: .module) }
    public static var saveButton: String { String(localized: "Save to File…", bundle: .module) }
    public static var copied: String { String(localized: "Copied the conversation to the clipboard", bundle: .module) }
    public static func saved(_ path: String) -> String {
        String(localized: "Saved the conversation to \(SessionNotices.abbreviatingHome(path))", bundle: .module)
    }
    public static func copiedResponse(_ n: Int) -> String {
        n <= 1 ? String(localized: "Copied Claude's last answer", bundle: .module)
               : String(localized: "Copied Claude's answer \(n) back", bundle: .module)
    }
    public static var copyUsage: String { String(localized: "Type a number after /copy — /copy 2 copies the answer before the last", bundle: .module) }
    /// "N lines · M characters" under the sheet's title.
    public static func size(_ text: String) -> String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).count - (text.hasSuffix("\n") ? 1 : 0)
        return String(localized: "\(lines) lines · \(text.count) characters", bundle: .module)
    }

    /// The engine's refusals of `export_chat` / `copy_response` in the user's words.
    public static func refusal(code: String, detail: String) -> String? {
        switch code {
        case "export_empty": return String(localized: "There is nothing in this chat to export yet", bundle: .module)
        case "export_empty_path": return String(localized: "Type a file name after /export", bundle: .module)
        case "export_path_too_long": return String(localized: "That path is too long", bundle: .module)
        case "export_exists":
            return detail.isEmpty ? String(localized: "That file exists already — /export never replaces one", bundle: .module)
                : String(localized: "\(SessionNotices.abbreviatingHome(detail)) exists already — /export never replaces a file", bundle: .module)
        case "export_failed":
            return String(localized: "Could not write the file: \(detail)", bundle: .module)
        case "no_response":
            return detail == "1" || detail.isEmpty ? String(localized: "Claude has not answered in this chat yet", bundle: .module)
                : String(localized: "This chat has fewer than \(detail) answers", bundle: .module)
        case "invalid_copy_n": return copyUsage
        default: return nil
        }
    }
}

public extension AppState {
    /// §70.3 `export_chat`: the text (and the path when `path` was given). Throws the engine's refusal.
    func exportChat(to path: String? = nil, replace: Bool = false) async throws -> ChatExport {
        let reply = try await reply(.exportChat(path: path, replace: replace))
        guard case let .chatExport(export) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return export
    }

    /// §70.3 `copy_response {n}`: Claude's Nth-latest answer. Throws the engine's refusal.
    func copyResponse(_ n: Int) async throws -> ResponseText {
        let reply = try await reply(.copyResponse(n: n))
        guard case let .responseText(text) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return text
    }
}
