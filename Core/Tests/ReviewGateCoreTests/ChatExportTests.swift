import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §70.3 on the Mac: `/export` and `/copy` — the commands, the replies, the parse and the words.
@Suite @MainActor struct ChatExportTests {
    private func sent(_ command: EngineCommand) throws -> [String: Any] {
        let data = try JSONEncoder().encode(EngineCommandEnvelope(id: "c1", command: command))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func event(_ json: String) throws -> EngineEvent { try JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8)) }

    @Test func theCommands() throws {
        let plain = try sent(.exportChat(path: nil, replace: false))
        #expect(plain["type"] as? String == "export_chat")
        #expect(plain.keys.sorted() == ["id", "type"])
        let file = try sent(.exportChat(path: "/Users/dev/chat.txt", replace: true))
        #expect(file["path"] as? String == "/Users/dev/chat.txt")
        #expect(file["replace"] as? Bool == true)
        let copy = try sent(.copyResponse(n: 2))
        #expect(copy["type"] as? String == "copy_response")
        #expect(copy["n"] as? Int == 2)
    }

    @Test func theReplies() throws {
        let export = try event(#"{"type":"chat_export","id":"c1","text":"> hi\n","name":"2026-11-26-120000-hi.txt","path":null}"#)
        #expect(export == .chatExport(ChatExport(text: "> hi\n", name: "2026-11-26-120000-hi.txt", path: nil)))
        let response = try event(#"{"type":"response_text","id":"c1","n":2,"text":"Done."}"#)
        #expect(response == .responseText(ResponseText(n: 2, text: "Done.")))
    }

    @Test func theSlashCommands() {
        #expect(SlashAppCommand.parse("/export chat.txt", entries: []) == .export("chat.txt"))
        #expect(SlashAppCommand.parse("/export", entries: []) == .export(""))
        #expect(SlashAppCommand.parse("/copy 3", entries: []) == .copy("3"))
        #expect(SlashAppCommand.parse("/export x", entries: [SlashCommandEntry(name: "export", group: .project)]) == nil)   // theirs wins
        #expect(CopyArgument.parse("") == 1)
        #expect(CopyArgument.parse(" 3 ") == 3)
        #expect(CopyArgument.parse("0") == nil)
        #expect(CopyArgument.parse("two") == nil)
        #expect(SlashAppCommand.argumentHint("export") == "[file]")
        #expect(SlashAppCommand.description("copy") == ChatExportText.copyDescription)
    }

    @Test func theWords() {
        #expect(EngineMessages.refusal(error: "export_exists:/Users/dev/x.txt").contains("x.txt"))
        #expect(EngineMessages.refusal(error: "no_response:1") == ChatExportText.refusal(code: "no_response", detail: "1"))
        #expect(EngineMessages.refusal(error: "no_response:4").contains("4"))
        #expect(ChatExportText.size("a\nb\n") == String(localized: "\(2) lines · \(4) characters", bundle: .module))
    }
}
