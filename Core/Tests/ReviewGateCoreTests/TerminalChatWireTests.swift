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

    // MARK: terminal-stage2 (§57.10–57.15)

    private func terminal(_ json: String) throws -> TerminalSessionInfo {
        try JSONDecoder().decode(TerminalSessionInfo.self, from: Data(json.utf8))
    }

    @Test func theStage2Fields() throws {
        let full = try terminal(#"""
        {"running":true,"hooksSeen":true,
         "status":{"costUsd":0.0123,"model":"claude-acme-test","modelName":"Acme","contextTokens":50000,"contextWindow":200000,"at":"2026-11-20T10:00:00.000Z"},
         "requestQueued":{"via":"next_prompt","noteIds":["n1"],"extra":"also tests","at":"2026-11-20T10:00:01.000Z"},
         "permissions":[{"requestId":"r1","toolName":"Bash","summary":"Bash: echo hi","reason":null,"since":"2026-11-20T10:00:02.000Z"},
                        {"requestId":"r2","toolName":"EnterWorktree","summary":"EnterWorktree","reason":"ReviewGate: x","since":"2026-11-20T10:00:03.000Z","canFollow":true}],
         "moving":{"path":"/work/acme-wt/fix","name":"fix"},
         "elsewhere":{"path":"/work/acme-wt/fix","name":"fix","toolName":"CwdChanged","canMove":true}}
        """#)
        #expect(full.status == TerminalStatus(costUsd: 0.0123, model: "claude-acme-test", modelName: "Acme", contextTokens: 50000,
                                              contextWindow: 200000, at: "2026-11-20T10:00:00.000Z"))
        #expect(full.status?.contextPercent == 25)
        #expect(full.requestQueued == TerminalRequestQueued(via: .nextPrompt, noteIds: ["n1"], extra: "also tests", at: "2026-11-20T10:00:01.000Z"))
        #expect(full.permissions == [
            TerminalPermission(requestId: "r1", toolName: "Bash", summary: "Bash: echo hi", since: "2026-11-20T10:00:02.000Z"),
            TerminalPermission(requestId: "r2", toolName: "EnterWorktree", summary: "EnterWorktree", reason: "ReviewGate: x",
                               since: "2026-11-20T10:00:03.000Z", canFollow: true),
        ])
        #expect(full.permissions.first?.id == "r1")
        #expect(full.moving == TerminalPlace(path: "/work/acme-wt/fix", name: "fix"))
        #expect(full.elsewhere == TerminalElsewhere(path: "/work/acme-wt/fix", name: "fix", toolName: "CwdChanged", canMove: true))
        #expect(try terminal(#"{"running":true,"requestQueued":{"via":"stop","noteIds":null,"extra":null,"at":"t"}}"#).requestQueued?.via == .stop)

        // Absent: none — an older engine.
        let absent = try terminal(#"{"running":true,"hooksSeen":true}"#)
        #expect(absent == TerminalSessionInfo(running: true, hooksSeen: true))
        #expect(absent.permissions.isEmpty)
        // null and malformed: none; one bad permission does not hide the others.
        let odd = try terminal(#"""
        {"running":true,"status":{"costUsd":"x"},"requestQueued":{"via":"fax","at":"t"},"moving":null,"elsewhere":{"path":1},
         "permissions":[{"requestId":"r1"},{"requestId":"r2","toolName":"Bash","summary":"Bash: ls","since":"t"}]}
        """#)
        #expect(odd.status == nil)
        #expect(odd.requestQueued == nil)
        #expect(odd.moving == nil)
        #expect(odd.elsewhere == nil)
        #expect(odd.permissions.map(\.requestId) == ["r2"])
        #expect(try terminal(#"{"permissions":{"r1":1}}"#).permissions.isEmpty)
        // A status with odd numbers keeps what decodes.
        let partial = try terminal(#"{"status":{"costUsd":null,"model":"m","contextTokens":"many","at":"t"}}"#).status
        #expect(partial == TerminalStatus(costUsd: nil, model: "m", modelName: nil, contextTokens: nil, contextWindow: nil, at: "t"))
        #expect(partial?.contextPercent == nil)
    }

    @Test func backgroundTerminals() throws {
        let json = #"""
        {"list":[],"currentId":"c1","openTabIds":["t1","c1"],"backgroundTerminals":[
          {"chatId":"t1","running":true,"hooksSeen":true,"waiting":{"kind":"question","message":"Pick one","since":"2026-11-20T10:00:00.000Z"}},
          {"chatId":"t2","running":false,"hooksSeen":false,"waiting":null},
          {"running":true}]}
        """#
        let sessions = try JSONDecoder().decode(SessionsInfo.self, from: Data(json.utf8))
        #expect(sessions.backgroundTerminals == [
            BackgroundTerminalInfo(chatId: "t1", running: true, hooksSeen: true,
                                   waiting: TerminalWaiting(kind: .question, message: "Pick one", since: "2026-11-20T10:00:00.000Z")),
            BackgroundTerminalInfo(chatId: "t2", running: false),
        ])
        #expect(sessions.backgroundTerminal("t2")?.running == false)
        #expect(sessions.backgroundTerminal("c1") == nil)
        let older = try JSONDecoder().decode(SessionsInfo.self, from: Data(#"{"list":[],"currentId":null,"openTabIds":[]}"#.utf8))
        #expect(older.backgroundTerminals.isEmpty)
        let odd = try JSONDecoder().decode(SessionsInfo.self, from: Data(#"{"list":[],"openTabIds":[],"backgroundTerminals":7}"#.utf8))
        #expect(odd.backgroundTerminals.isEmpty)
        // Round trip (the app re-encodes snapshots in tests and fixtures).
        #expect(try JSONDecoder().decode(SessionsInfo.self, from: JSONEncoder().encode(sessions)) == sessions)
    }

    @Test func theStage2Commands() throws {
        let cancel = try sent(.terminalRequestCancel(sessionId: "s1"))
        #expect(cancel["type"] as? String == "terminal_request_cancel")
        #expect(cancel["sessionId"] as? String == "s1")

        let allow = try sent(.terminalPermissionResponse(sessionId: "s1", requestId: "r1", allow: true))
        #expect(allow["type"] as? String == "terminal_permission_response")
        #expect(allow["sessionId"] as? String == "s1")
        #expect(allow["requestId"] as? String == "r1")
        #expect(allow["allow"] as? Bool == true)
        #expect(!allow.keys.contains("message"))
        #expect(!allow.keys.contains("follow"))

        let deny = try sent(.terminalPermissionResponse(sessionId: "s1", requestId: "r2", allow: false, message: "Not now"))
        #expect(deny["allow"] as? Bool == false)
        #expect(deny["message"] as? String == "Not now")
        #expect(!deny.keys.contains("follow"))

        let follow = try sent(.terminalPermissionResponse(sessionId: "s1", requestId: "r3", allow: true, follow: true))
        #expect(follow["follow"] as? Bool == true)
    }

    @Test func thePermissionBridgeSetting() throws {
        var settings = EngineSettings()
        #expect(try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any] != nil)
        settings.terminalPermissionBridge = false
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any])
        #expect(json["terminalPermissionBridge"] as? Bool == false)
    }
}
