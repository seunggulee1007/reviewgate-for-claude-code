import Foundation
import Testing
@testable import ReviewGateCore

/// wave1 mac-perms: the §33 permission fields on the wire (docs/PROTOCOL.md §33.1 / §33.3 / §33.6 / §33.8, §29 peerTurn)
/// — decoded from the engine's golden snapshots with the queue filled in the shapes `engine.permqueue.test.ts` asserts,
/// leniently (an unknown value never fails a snapshot), and the commands / settings the client sends.
@Suite struct PermissionWireTests {
    private static let fixtures: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // Tests/ReviewGateCoreTests/<file> → repo root
        return url.appendingPathComponent("engine/test/fixtures/wire")
    }()

    /// A golden snapshot with `edit` applied to its `session` object.
    static func snapshot(_ name: String, edit: (inout [String: Any]) -> Void) throws -> ReviewState {
        let data = try Data(contentsOf: fixtures.appendingPathComponent(name))
        var root = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        var session = try #require(root["session"] as? [String: Any])
        edit(&session)
        root["session"] = session
        let edited = try JSONSerialization.data(withJSONObject: root)
        return try NDJSON.decoder.decode(ReviewState.self, from: edited)
    }

    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(value)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// Two parallel subagents' requests as the engine sends them (attributed from `state.hud.agents`).
    static var queueJSON: [[String: Any]] {
        [
            ["requestId": "R1", "toolName": "Bash", "input": ["command": "./gradlew :acme-api:compileJava"], "toolUseId": "bashA",
             "agent": ["agentId": "taskA", "agentToolUseId": "agA", "subagentType": "executor", "description": "compile"]],
            ["requestId": "R2", "toolName": "mcp__github__get_issue", "input": ["issue_number": "1"], "toolUseId": "t2",
             "agent": ["agentId": "unknown-task"],
             "allowPatterns": ["mcp__github__get_issue", "mcp__github__*"]],
            ["requestId": "R3", "toolName": "Edit", "input": ["file_path": "/repo/.claude/worktrees/wt1/a.ts"], "file": "/repo/.claude/worktrees/wt1/a.ts",
             "toolUseId": "t3", "reason": ["code": "nested_repository", "message": "ReviewGate: edit inside a nested repository", "path": "/repo/.claude/worktrees/wt1"]],
        ]
    }

    // MARK: - Decoding

    @Test func decodesTheQueueAttributionReasonsAndPatternsFromASnapshot() throws {
        let state = try Self.snapshot("state.reviewing.json") { session in
            session["pendingPermissions"] = Self.queueJSON
            session["pendingPermission"] = Self.queueJSON[0]
            session["peerTurn"] = ["messageIds": ["m1", "m2"], "fromNames": ["acme-b4", "acme-63"]]
        }
        let queue = state.session.pendingPermissions
        #expect(queue.map(\.requestId) == ["R1", "R2", "R3"])
        #expect(state.session.pendingPermission?.requestId == "R1")
        #expect(state.session.permissionQueue == queue)
        #expect(queue[0].toolUseId == "bashA")
        #expect(queue[0].agent == PermissionAgent(agentId: "taskA", agentToolUseId: "agA", subagentType: "executor", description: "compile"))
        #expect(queue[0].reason == nil && queue[0].allowPatterns.isEmpty)
        #expect(queue[1].agent == PermissionAgent(agentId: "unknown-task"))
        #expect(queue[1].allowPatterns == ["mcp__github__get_issue", "mcp__github__*"])
        #expect(queue[2].reason == PermissionReason(code: .nestedRepository, message: "ReviewGate: edit inside a nested repository", path: "/repo/.claude/worktrees/wt1"))
        #expect(queue[2].file == "/repo/.claude/worktrees/wt1/a.ts")
        #expect(state.session.peerTurn == PeerTurnInfo(messageIds: ["m1", "m2"], fromNames: ["acme-b4", "acme-63"]))
        // The rest of the golden is untouched.
        #expect(state.seq == 42 && state.session.open)
    }

    @Test func theGoldensCarryAnEmptyQueueAndNoPeerTurn() throws {
        for name in ["state.initial.json", "state.reviewing.json"] {
            let state = try NDJSON.decode(ReviewState.self, from: String(contentsOf: Self.fixtures.appendingPathComponent(name), encoding: .utf8))
            #expect(state.session.pendingPermissions.isEmpty && state.session.permissionQueue.isEmpty)
            #expect(state.session.peerTurn == nil)
        }
    }

    @Test func decodesThePermissionRequestEventWithEveryField() throws {
        let line = #"{"type":"permission_request","requestId":"W1","toolName":"Agent","input":{"description":"wf","isolation":"worktree"},"toolUseId":"ag9","agent":{"agentId":"t9","agentToolUseId":"ag8","subagentType":"planner","description":"plan it"},"reason":{"code":"worktree_isolation","message":"runs in an isolated worktree"},"allowPatterns":[]}"#
        guard case let .permissionRequest(request) = try NDJSON.decode(EngineEvent.self, from: line) else {
            Issue.record("not a permission_request"); return
        }
        #expect(request.requestId == "W1" && request.toolName == "Agent" && request.toolUseId == "ag9")
        #expect(request.agent?.subagentType == "planner" && request.agent?.agentToolUseId == "ag8")
        #expect(request.reason?.code == .worktreeIsolation && request.reason?.path == nil)
        #expect(request.input["isolation"] == .string("worktree"))
        // An older engine's event (no §33 fields) still decodes, as before.
        let old = try NDJSON.decode(EngineEvent.self, from: #"{"type":"permission_request","requestId":"r1","toolName":"Bash","input":{"command":"ls"}}"#)
        #expect(old == .permissionRequest(PermissionRequest(requestId: "r1", toolName: "Bash", input: .object(["command": .string("ls")]))))
    }

    @Test func unknownAndMalformedValuesNeverFailTheSnapshot() throws {
        let state = try Self.snapshot("state.reviewing.json") { session in
            session["pendingPermissions"] = [
                // A reason code from a newer engine: kept, the card shows its message.
                ["requestId": "N1", "toolName": "Write", "input": [:], "reason": ["code": "brand_new_place", "message": "Somewhere new"]],
                // `claude_config` (engine follow-up) is known; M22: its `keys`, a bad entry among them left out.
                ["requestId": "N2", "toolName": "Edit", "input": [:], "reason": ["code": "claude_config", "message": "settings", "path": "/repo/.claude/settings.local.json", "keys": ["permissions", 3, "env.PATH"]]],
                // Malformed optional fields fall back instead of failing.
                ["requestId": "N3", "toolName": "Bash", "input": "not an object", "agent": "taskA", "allowPatterns": ["Bash(ls)", 7, NSNull()], "toolUseId": 12],
                // An entry without a request id cannot be answered: dropped, the rest stays.
                ["toolName": "Bash", "input": [:]],
                ["requestId": "N4", "toolName": "WebFetch", "input": ["url": "https://docs.spring.io"]],
            ]
            session["peerTurn"] = "garbage"
        }
        let queue = state.session.pendingPermissions
        #expect(queue.map(\.requestId) == ["N1", "N2", "N3", "N4"])
        #expect(queue[0].reason?.code == .other("brand_new_place") && queue[0].reason?.message == "Somewhere new")
        #expect(queue[1].reason?.code == .claudeConfig && queue[1].reason?.keys == ["permissions", "env.PATH"])
        #expect(queue[0].reason?.keys == nil)
        #expect(queue[2].agent == nil && queue[2].toolUseId == nil && queue[2].input == .string("not an object"))
        #expect(queue[2].allowPatterns == ["Bash(ls)"])
        #expect(state.session.peerTurn == nil)
        // `pendingPermissions: null` reads as the single slot.
        let nulled = try Self.snapshot("state.reviewing.json") { session in
            session["pendingPermissions"] = NSNull()
            session["pendingPermission"] = Self.queueJSON[0]
        }
        #expect(nulled.session.pendingPermissions.map(\.requestId) == ["R1"])
    }

    @Test func anOlderEngineSendingOnlyTheSlotGetsAOneElementQueue() throws {
        let state = try Self.snapshot("state.reviewing.json") { session in
            session.removeValue(forKey: "pendingPermissions")
            session.removeValue(forKey: "peerTurn")
            session["pendingPermission"] = Self.queueJSON[1]
        }
        #expect(state.session.pendingPermissions.map(\.requestId) == ["R2"])
        #expect(state.session.permissionQueue.map(\.requestId) == ["R2"])
        let empty = try Self.snapshot("state.reviewing.json") { session in session.removeValue(forKey: "pendingPermissions") }
        #expect(empty.session.permissionQueue.isEmpty)
    }

    @Test func decodesPermissionRulesLenientlyAsATypedReply() throws {
        let line = #"""
        {"type":"permission_rules","id":"q1","sources":[{"scope":"user","path":"~/.claude/settings.json","exists":true},{"scope":"local","path":"/repo/.claude/settings.local.json","exists":true,"error":"Unexpected token"},{"scope":"project","path":"/repo/.claude/settings.json","exists":false}],"rules":[{"rule":"mcp__github","source":"user","status":"applied","why":"read_mcp_tools","importAs":"mcp__github__*"},{"rule":"Bash(./gradlew:*)","source":"local","status":"ignored","why":"bash","importAs":"Bash(./gradlew:*)"},{"rule":"Edit","source":"project","status":"ignored","why":"edit_tool","importAs":null},{"rule":"Thing","source":"enterprise","status":"pondering","why":"brand_new_why","importAs":""},{"source":"user"}],"defaultMode":"auto","defaultModeSupported":true,"applyUserAllowRules":true,"loadUserSettings":true}
        """#
        let event = try NDJSON.decode(EngineEvent.self, from: line)
        #expect(event.replyId == "q1")
        guard case let .permissionRules(reply) = event else { Issue.record("not permission_rules"); return }
        #expect(reply.sources.map(\.scope) == [.user, .local, .project])
        #expect(reply.sources[1].error == "Unexpected token" && !reply.sources[2].exists)
        #expect(reply.rules.count == 4)   // the entry without a rule is dropped
        #expect(reply.rules[0] == UserPermissionRule(rule: "mcp__github", source: .user, status: .applied, why: .readMcpTools, importAs: "mcp__github__*"))
        #expect(reply.rules[1].why == .bash && reply.rules[1].importAs == "Bash(./gradlew:*)")
        #expect(reply.rules[2].importAs == nil && reply.rules[2].why == .editTool)
        #expect(reply.rules[3].source == .other("enterprise") && reply.rules[3].status == .other("pondering") && reply.rules[3].why == .other("brand_new_why"))
        #expect(reply.rules[3].importAs == nil)   // an empty importAs cannot be imported
        #expect(reply.supportedDefaultMode == .auto)
        let unsupported = PermissionRulesReply(defaultMode: "bypassPermissions", defaultModeSupported: false)
        #expect(unsupported.supportedDefaultMode == nil)
        // A bare reply with nothing in it decodes to the defaults.
        guard case let .permissionRules(bare) = try NDJSON.decode(EngineEvent.self, from: #"{"type":"permission_rules"}"#) else {
            Issue.record("not permission_rules"); return
        }
        #expect(bare == PermissionRulesReply())
    }

    // MARK: - Encoding

    @Test func encodesPermissionRulesAndTheSection33Settings() throws {
        let rules = try json(EngineCommandEnvelope(id: "q", command: .permissionRules))
        #expect(rules["type"] as? String == "permission_rules" && rules["id"] as? String == "q")
        #expect(Set(rules.keys) == ["type", "id"])

        var settings = EngineSettings()
        settings.allowWorktreeIsolation = true
        settings.applyUserAllowRules = false
        settings.persistSessionAllows = true
        settings.applyUserBashRules = false   // MARK: r2-skills-side (§33.5, M20)
        let set = try json(EngineCommandEnvelope(command: .setSettings(settings)))
        let payload = try #require(set["settings"] as? [String: Any])
        #expect(Set(payload.keys) == ["allowWorktreeIsolation", "applyUserAllowRules", "applyUserBashRules", "persistSessionAllows"])
        #expect(payload["applyUserBashRules"] as? Bool == false)
        #expect(payload["allowWorktreeIsolation"] as? Bool == true && payload["applyUserAllowRules"] as? Bool == false)
        // Nothing set → nothing sent (a plain set_settings never resets them).
        let plain = try json(EngineCommandEnvelope(command: .setSettings(EngineSettings(budget: Budget(maxFiles: 1, maxLines: 2)))))
        #expect((plain["settings"] as? [String: Any]).map { Set($0.keys) } == ["budget"])
    }

    @Test func aRequestRoundTripsWithItsSection33Fields() throws {
        let request = PermissionRequest(requestId: "R", toolName: "Bash", input: .object(["command": .string("make")]), file: nil, toolUseId: "t",
                                        agent: PermissionAgent(agentId: "a", agentToolUseId: "ag"),
                                        reason: PermissionReason(code: .otherWorktree, message: "m", path: "/wt"), allowPatterns: ["Bash(make)"])
        let data = try JSONEncoder().encode(request)
        #expect(try JSONDecoder().decode(PermissionRequest.self, from: data) == request)
        let wire = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect((wire["reason"] as? [String: Any])?["code"] as? String == "other_worktree")
        // M22: `keys` round-trip too.
        let keyed = PermissionRequest(requestId: "K", toolName: "Write", input: .object([:]), file: nil, toolUseId: nil, reason: PermissionReason(code: .claudeConfig, message: "m", path: "/repo/.claude/settings.json", keys: ["hooks"]))
        #expect(try JSONDecoder().decode(PermissionRequest.self, from: JSONEncoder().encode(keyed)) == keyed)
        // Without the §33 fields nothing extra goes on the wire.
        let plain = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(PermissionRequest(requestId: "p", toolName: "Bash", input: .object([:])))) as? [String: Any])
        #expect(Set(plain.keys) == ["requestId", "toolName", "input"])
    }
}
