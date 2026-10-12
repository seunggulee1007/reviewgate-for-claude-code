import Foundation
import Testing
@testable import ReviewGateCore

/// wave4b w4b-check4: the §39.4 / §39.5 / §40.1 shapes as the engine really sends them (`engine/test/fixtures/wire/
/// wave4.follow.json`, written by engine.wave4Wire.test.ts) — a moved chat, its refusals and notices, the auto-mode rows and
/// a hook that blocked; plus the turn-end stop reason in words.
@Suite struct Wave4WireGoldenTests {
    private static let fixture: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("engine/test/fixtures/wire/wave4.follow.json")
    }()

    private func golden() throws -> [String: Any] {
        let data = try Data(contentsOf: Self.fixture)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed])
        return try NDJSON.decode(type, from: String(decoding: data, as: UTF8.self))
    }

    @Test func noticesDecodeWithTheirFactsAndWords() throws {
        let notices = try #require(golden()["notices"] as? [Any]).map { try decode(EngineEvent.self, $0) }
        #expect(notices.count == 4)
        var details: [EngineErrorDetail] = []
        for n in notices {
            guard case let .error(message, fatal, scope, detail) = n else { Issue.record("not an error: \(n)"); return }
            #expect(!fatal && scope == .session)
            #expect(SessionNotices.isNotice(code: detail.code, fatal: false))
            details.append(detail)
            _ = message
        }
        #expect(details.map(\.code) == ["auto_mode_denied", "auto_mode_unavailable", "hook_blocked", "hook_failed"])
        #expect(details[0].toolName == "Bash")
        #expect(EngineMessages.error(message: "x", detail: details[0]) == "Auto mode blocked: git push --force — [Security Weaken]")
        #expect(details[2].hookName == "PreToolUse:Bash" && details[2].exitCode == 2 && details[2].detail == "no rm -rf in this repo")
        #expect(EngineMessages.error(message: "x", detail: details[2]) == "Blocked by a hook: PreToolUse:Bash — no rm -rf in this repo")
        #expect(SessionNotices.secondaryLine(message: "x", detail: details[2]) == nil)
        #expect(EngineMessages.error(message: "x", detail: details[3]) == "A hook failed: PostToolUse:Bash")
    }

    @Test func turnEndSaysWhyInWords() throws {
        let ev = try decode(EngineEvent.self, try #require(golden()["turnEnd"]))
        guard case let .turnEnd(stopReason, usage, files, added, deleted, external, review) = ev else { Issue.record("turn_end"); return }
        #expect(stopReason == "error_max_turns")
        let row = TurnEndText.row(stopReason: stopReason, usage: usage, files: files, added: added, deleted: deleted, external: external, review: review)
        #expect(row.contains("Stopped at the tool-call limit"))
        #expect(!row.contains("error_max_turns"))
        #expect(TurnEndText.stopWords("success") == "Finished")
        #expect(TurnEndText.stopWords("interrupted") == "Stopped by you")
        #expect(TurnEndText.stopWords("something_new") == "something_new")
    }

    @Test func movedChatRefusalsEventAndMetas() throws {
        let g = try golden()
        let results = try #require(g["results"] as? [Any]).map { try decode(EngineEvent.self, $0) }
        let summary: [[String?]] = results.compactMap { event -> [String?]? in
            guard case let .result(id, ok, _, code, _) = event else { return nil }
            let row: [String?] = [id, ok ? "ok" : "refused", code]
            return row
        }
        #expect(summary == [["req-same", "refused", "same_worktree"], ["req-missing", "refused", "path_not_found"],
                            ["req-move", "ok", nil], ["req-record", "refused", "chat_is_record"]])

        let moved = try decode(EngineEvent.self, try #require(g["chatMoved"]))
        #expect(moved == .chatMoved(ChatMovedEvent(sessionId: "chat-1", path: "/repo-wt", name: "repo-wt", reviewsFromHead: false, interrupted: false)))

        let source = try decode(SessionMeta.self, try #require(g["sourceMeta"]))
        #expect(source.movedTo == ChatMoveRef(path: "/repo-wt", name: "repo-wt", at: "2026-01-02T03:04:05.000Z"))
        #expect(source.movedFrom == nil)
        let target = try decode(SessionMeta.self, try #require(g["targetMeta"]))
        #expect(target.movedFrom == ChatMoveRef(path: "/repo", name: "repo", at: "2026-01-02T03:04:05.000Z"))
        #expect(target.movedTo == nil)

        let movedIn = try #require(g["movedIn"] as? [Any]).map { try decode(EngineEvent.self, $0) }
        guard case let .error(_, fatal, scope, detail) = try #require(movedIn.first) else { Issue.record("chat_moved_in_disk"); return }
        #expect(!fatal && scope == .session)
        #expect(detail.code == "chat_moved_in_disk" && detail.path == "/repo" && detail.sessionId == "chat-1")
    }
}
