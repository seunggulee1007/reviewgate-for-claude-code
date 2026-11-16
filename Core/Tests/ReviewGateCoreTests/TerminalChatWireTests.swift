import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §57.1 on the Mac: a terminal chat's wire — `SessionMeta.kind` / `cliSessionId`, the `terminal_*`
/// commands, the `terminal_spec` reply and `state.session.terminal`. Engine: engine.terminalChat.test.ts.
@Suite struct TerminalChatWireTests {
    private func sent(_ command: EngineCommand) throws -> [String: Any] {
        let data = try JSONEncoder().encode(EngineCommandEnvelope(id: "c1", command: command))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func meta(_ json: String) throws -> SessionMeta {
        try JSONDecoder().decode(SessionMeta.self, from: Data(json.utf8))
    }

    @Test func aChatsKindDecodesLeniently() throws {
        #expect(try meta(#"{"id":"s1","title":"t"}"#).kind == .chat)
        #expect(try meta(#"{"id":"s1","title":"t","kind":"terminal"}"#).kind == .terminal)
        #expect(try meta(#"{"id":"s1","title":"t","kind":"hologram"}"#).kind == .chat)
        #expect(try meta(#"{"id":"s1","title":"t","kind":7}"#).kind == .chat)
        #expect(try meta(#"{"id":"s1","title":"t"}"#).cliSessionId == nil)
        #expect(try meta(#"{"id":"s1","title":"t","cliSessionId":""}"#).cliSessionId == nil)
        #expect(try meta(#"{"id":"s1","title":"t","kind":"terminal","cliSessionId":"s2"}"#).cliSessionId == "s2")
    }

    @Test func kindIsWrittenOnlyForATerminalChat() throws {
        let chat = try JSONSerialization.jsonObject(with: JSONEncoder().encode(SessionMeta(id: "s1", title: "t"))) as? [String: Any]
        #expect(chat?["kind"] == nil)
        #expect(chat?["cliSessionId"] == nil)
        var terminal = SessionMeta(id: "s1", title: "t")
        terminal.kind = .terminal
        terminal.cliSessionId = "s2"
        let data = try JSONEncoder().encode(terminal)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(json?["kind"] as? String == "terminal")
        #expect(json?["cliSessionId"] as? String == "s2")
        #expect(try JSONDecoder().decode(SessionMeta.self, from: data) == terminal)
    }

    @Test func theCommands() throws {
        let plain = try sent(.sessionNew)
        #expect(plain["type"] as? String == "session_new")
        #expect(plain["kind"] == nil)
        let terminal = try sent(.sessionNewTerminal)
        #expect(terminal["type"] as? String == "session_new")
        #expect(terminal["kind"] as? String == "terminal")

        let spec = try sent(.terminalSpec(sessionId: "s1"))
        #expect(spec["type"] as? String == "terminal_spec")
        #expect(spec["sessionId"] as? String == "s1")

        let started = try sent(.terminalStarted(sessionId: "s1", pid: 4242))
        #expect(started["type"] as? String == "terminal_started")
        #expect(started["sessionId"] as? String == "s1")
        #expect(started["pid"] as? Int == 4242)

        let exited = try sent(.terminalExited(sessionId: "s1", exitCode: 3))
        #expect(exited["type"] as? String == "terminal_exited")
        #expect(exited["exitCode"] as? Int == 3)
        let signalled = try sent(.terminalExited(sessionId: "s1", exitCode: nil))
        #expect(signalled.keys.contains("exitCode"))
        #expect(signalled["exitCode"] is NSNull)

        let end = try sent(.terminalEndTurn(sessionId: "s1"))
        #expect(end["type"] as? String == "terminal_end_turn")
        #expect(end["sessionId"] as? String == "s1")
    }

    @Test func theSpecReply() throws {
        let json = #"""
        {"type":"terminal_spec","id":"c1","sessionId":"s1","argv":["/usr/local/bin/claude","--resume","s1","--settings","{}"],
         "env":{"RG_HOOK_TOKEN":"abc"},"cwd":"/work/acme","resume":true}
        """#
        let event = try JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8))
        let spec = TerminalSpec(id: "c1", sessionId: "s1", argv: ["/usr/local/bin/claude", "--resume", "s1", "--settings", "{}"],
                                env: ["RG_HOOK_TOKEN": "abc"], cwd: "/work/acme", resume: true)
        #expect(event == .terminalSpec(spec))
        #expect(event.replyId == "c1")
    }

    @Test func theSessionsTerminalState() throws {
        let with = #"""
        {"open":true,"starting":false,"terminal":{"running":true,"hooksSeen":true,"promptId":"p1",
         "waiting":{"kind":"permission","message":"Claude needs your permission to use Bash","since":"2026-11-16T10:00:00.000Z"},
         "interruptSuspected":false}}
        """#
        let info = try JSONDecoder().decode(SessionInfo.self, from: Data(with.utf8))
        #expect(info.terminal == TerminalSessionInfo(
            running: true, hooksSeen: true, promptId: "p1",
            waiting: TerminalWaiting(kind: .permission, message: "Claude needs your permission to use Bash", since: "2026-11-16T10:00:00.000Z")))
        let without = try JSONDecoder().decode(SessionInfo.self, from: Data(#"{"open":true,"starting":false}"#.utf8))
        #expect(without.terminal == nil)
        let null = try JSONDecoder().decode(SessionInfo.self, from: Data(#"{"open":true,"starting":false,"terminal":null}"#.utf8))
        #expect(null.terminal == nil)
        let odd = try JSONDecoder().decode(SessionInfo.self, from: Data(#"{"open":true,"starting":false,"terminal":{"running":true,"waiting":{"kind":"x"}}}"#.utf8))
        #expect(odd.terminal == TerminalSessionInfo(running: true, hooksSeen: false))
    }
}
