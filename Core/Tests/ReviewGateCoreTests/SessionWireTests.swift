import Foundation
import Testing
@testable import ReviewGateCore

/// wave1 mac-session: docs/PROTOCOL.md §29 / §30 on the wire — the session fields of the golden fixtures, the lenient
/// decoding of new fields and enums, the new event, transcript rows and commands.
@Suite struct SessionWireTests {
    private static let fixtures: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // Tests/ReviewGateCoreTests/<file> → repo root
        return url.appendingPathComponent("engine/test/fixtures/wire")
    }()

    private func fixture(_ name: String) throws -> String {
        try String(contentsOf: Self.fixtures.appendingPathComponent(name), encoding: .utf8)
    }

    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(value)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Goldens

    @Test func goldenStatesCarryTheSessionFields() throws {
        let initial = try NDJSON.decode(ReviewState.self, from: try fixture("state.initial.json"))
        #expect(initial.session.ready == false)
        #expect(initial.session.peerInbound == .auto)   // r2-peers: the engine's default
        #expect(initial.session.peerInbox.isEmpty)
        #expect(initial.session.externalTurn == nil)

        let reviewing = try NDJSON.decode(ReviewState.self, from: try fixture("state.reviewing.json"))
        #expect(reviewing.session.ready == true)
        #expect(reviewing.session.peerInbound == .auto)
        #expect(reviewing.sessions?.list.first?.cliKnown == true)
        #expect(reviewing.sessions?.list.first?.resumeFailed == false)
    }

    // MARK: - Lenient decoding

    @Test func unknownValuesNeverFailTheSnapshot() throws {
        let line = #"""
        {"open":true,"starting":false,"sessionId":"s","model":null,"capabilities":null,"pendingPermission":null,
         "ready":"yes","peerInbound":"sometimes",
         "peerInbox":[
           {"id":"m1","from":"uds:/tmp/cc-socks/4242.sock","fromName":"acme-b4","verifiedPeerPid":null,"cause":"explicit-setting","receivedAt":"2026-10-22T01:02:03Z","state":"held"},
           42,
           {"id":"","from":"x","state":"held"},
           {"id":"m2","from":"uds:/tmp/cc-socks/7.sock","fromName":null,"state":"teleported","unprompted":"no"}
         ],
         "externalTurn":{"commandUuid":null,"since":"2026-10-22T01:02:04Z","peer":{"from":"uds:/tmp/cc-socks/4242.sock","fromName":null,"verifiedPeerPid":4242}}}
        """#
        let session = try NDJSON.decode(SessionInfo.self, from: line)
        #expect(session.ready == nil)                 // wrong type → unknown
        #expect(session.peerInbound == nil)           // unknown mode → nil
        #expect(session.peerInbox.map(\.id) == ["m1", "m2"])   // a number and an id-less entry are skipped
        #expect(session.peerInbox[0].state == .held)
        #expect(session.peerInbox[0].senderName == "acme-b4")
        #expect(session.peerInbox[1].state == .other("teleported"))
        #expect(session.peerInbox[1].unprompted == false)
        #expect(session.peerInbox[1].senderName == "pid 7")   // no name: the pid from the reply address
        #expect(session.externalTurn?.peer?.verifiedPeerPid == 4242)
        #expect(session.externalTurn?.since == "2026-10-22T01:02:04Z")

        // Older engines: none of the fields.
        let old = try NDJSON.decode(SessionInfo.self, from: #"{"open":false,"starting":false}"#)
        #expect(old.ready == nil && old.peerInbound == nil && old.peerInbox.isEmpty && old.externalTurn == nil)
        // A chat without `cliKnown`.
        #expect(try NDJSON.decode(SessionMeta.self, from: #"{"id":"c1"}"#).cliKnown == false)
        #expect(try NDJSON.decode(SessionMeta.self, from: #"{"id":"c1","cliKnown":true,"resumeFailed":true}"#).cliKnown == true)
    }

    @Test func sessionMetaKeepsCliKnownWhenEncoded() throws {
        var meta = SessionMeta(id: "c1", title: "t")
        meta.cliKnown = true
        let wire = try json(meta)
        #expect(wire["cliKnown"] as? Bool == true)
        #expect(try json(SessionMeta(id: "c2", title: "t"))["cliKnown"] == nil)
    }

    // MARK: - Events

    @Test func decodesPeerMessageEvent() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"{"type":"peer_message","message":{"id":"m1","from":"uds:/tmp/cc-socks/1.sock","fromName":"term","verifiedPeerPid":99,"cause":null,"receivedAt":"2026-10-22T01:02:03Z","state":"delivered","body":"Run the tests","turn":4}}"#)
        #expect(event == .peerMessage(PeerMessage(id: "m1", from: "uds:/tmp/cc-socks/1.sock", fromName: "term", verifiedPeerPid: 99,
                                                  receivedAt: "2026-10-22T01:02:03Z", state: .delivered, body: "Run the tests", turn: 4)))
    }

    @Test func decodesErrorEventSessionFields() throws {
        let start = try NDJSON.decode(EngineEvent.self, from: #"{"type":"error","message":"Claude Code exited while starting.","fatal":true,"scope":"session","code":"session_start_failed","detail":"error: unknown option '--frobnicate'","exitCode":1,"signal":null}"#)
        guard case let .error(_, fatal, scope, detail) = start else { Issue.record("not an error"); return }
        #expect(fatal && scope == .session)
        #expect(detail.code == "session_start_failed" && detail.detail == "error: unknown option '--frobnicate'")
        #expect(detail.exitCode == 1 && detail.signal == nil)

        let resume = try NDJSON.decode(EngineEvent.self, from: #"{"type":"error","message":"no record","fatal":false,"scope":"session","code":"resume_not_found","sessionId":"old-chat","detail":"No conversation found"}"#)
        guard case let .error(_, _, _, d2) = resume else { Issue.record("not an error"); return }
        #expect(d2.sessionId == "old-chat" && d2.detail == "No conversation found")

        let worktree = try NDJSON.decode(EngineEvent.self, from: #"{"type":"error","message":"m","fatal":false,"scope":"session","code":"worktree_blocked","toolName":"EnterWorktree","branch":"feature-x","path":"/repo/.claude/worktrees/feature-x","exitCode":"nope"}"#)
        guard case let .error(_, _, _, d3) = worktree else { Issue.record("not an error"); return }
        #expect(d3.toolName == "EnterWorktree" && d3.branch == "feature-x" && d3.path == "/repo/.claude/worktrees/feature-x")
        #expect(d3.exitCode == nil)   // a wrong type is dropped, not fatal
    }

    @Test func decodesErrorAndPeerTranscriptRows() throws {
        let line = #"""
        {"type":"transcript_restore","items":[
          {"at":"2026-10-22T01:00:00Z","turn":3,"kind":"peer_message","id":"m1","from":"uds:/tmp/cc-socks/9.sock","fromName":"term","verifiedPeerPid":9,"state":"delivered","body":"hi"},
          {"at":"2026-10-22T01:00:01Z","turn":3,"kind":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}},
          {"at":"2026-10-22T01:00:02Z","turn":3,"kind":"error","message":"Claude Code exited while starting.","fatal":true,"scope":"session","code":"session_start_failed","detail":"boom"},
          {"at":"2026-10-22T01:00:03Z","turn":3,"kind":"error","message":"odd","fatal":false,"scope":"nowhere"},
          {"at":"2026-10-22T01:00:04Z","turn":3,"kind":"peer_message","id":"m2","from":"uds:/tmp/cc-socks/9.sock","state":"dropped","outcome":"refused"},
          {"at":"2026-10-22T01:00:05Z","turn":3,"kind":"brand_new_row"}
        ]}
        """#
        guard case let .transcriptRestore(items) = try NDJSON.decode(EngineEvent.self, from: line) else { Issue.record("not a restore"); return }
        #expect(items.count == 6)
        guard case let .peerMessage(first) = items[0].kind else { Issue.record("not a peer row"); return }
        #expect(first.state == .delivered && first.body == "hi" && first.turn == 3 && first.receivedAt == "2026-10-22T01:00:00Z")
        #expect(items[2].kind == .error(message: "Claude Code exited while starting.", fatal: true, scope: .session,
                                        code: "session_start_failed", detail: "boom"))
        #expect(items[3].kind == .error(message: "odd", fatal: false, scope: .session, code: nil, detail: nil))   // unknown scope
        guard case let .peerMessage(dropped) = items[4].kind else { Issue.record("not a peer row"); return }
        #expect(dropped.state == .dropped && dropped.outcome == "refused")
        #expect(items[5].kind == .other(kind: "brand_new_row"))
    }

    /// §35.3: an error row keeps the details its banner read; null / odd values read as absent; an older row has none.
    @Test func errorRowsCarryTheirDetails() throws {
        let row = try NDJSON.decode(TranscriptItem.self, from: #"{"at":"t","turn":2,"kind":"error","message":"m","fatal":false,"scope":"session","code":"worktree_blocked","toolName":"EnterWorktree","branch":"feat-y","path":"/p/wt","exitCode":1,"signal":null,"sessionId":"s1","resetAt":"2026-10-22T09:30:00Z","status":"x"}"#)
        guard case let .error(_, _, _, code, _, facts) = row.kind else { Issue.record("not an error row"); return }
        #expect(code == "worktree_blocked")
        #expect(facts.toolName == "EnterWorktree" && facts.branch == "feat-y" && facts.path == "/p/wt" && facts.exitCode == 1)
        #expect(facts.signal == nil && facts.sessionId == "s1" && facts.resetAt == "2026-10-22T09:30:00Z" && facts.status == nil)
        let old = try NDJSON.decode(TranscriptItem.self, from: #"{"at":"t","turn":2,"kind":"error","message":"m","fatal":false,"scope":"session"}"#)
        guard case let .error(_, _, _, _, _, none) = old.kind else { Issue.record("not an error row"); return }
        #expect(none == EngineErrorDetail())
        // The row's own details win over what the words say; a row without them is read back from the words.
        let blocked = "Claude tried to work in Workflow outside this folder; ReviewGate blocked it because this window's review would not see that work."
        let detailed = SessionNotices.restoredDetail(code: "worktree_blocked", detail: nil, message: blocked, facts: facts)
        #expect(detailed.toolName == "EnterWorktree" && detailed.branch == "feat-y" && detailed.code == "worktree_blocked")
        #expect(SessionNotices.restoredDetail(code: "worktree_blocked", detail: nil, message: blocked).toolName == "Workflow")
    }

    // MARK: - Commands and settings

    @Test func encodesPeerCommands() throws {
        let accept = try json(EngineCommandEnvelope(id: "1", command: .peerAccept(ids: ["m1", "m2"])))
        #expect(accept["type"] as? String == "peer_accept" && accept["ids"] as? [String] == ["m1", "m2"] && accept["id"] as? String == "1")
        let dismiss = try json(EngineCommandEnvelope(command: .peerDismiss(ids: nil)))
        #expect(dismiss["type"] as? String == "peer_dismiss" && dismiss["ids"] == nil)
        let set = try json(EngineCommandEnvelope(command: .peerSet(mode: .off)))
        #expect(set["type"] as? String == "peer_set" && set["mode"] as? String == "off")

        var settings = EngineSettings()
        settings.peerInbound = .auto
        let wire = try json(EngineCommandEnvelope(command: .setSettings(settings)))
        #expect((wire["settings"] as? [String: Any])?["peerInbound"] as? String == "auto")
        // Untouched fields stay out of a partial `set_settings`.
        let empty = try json(EngineCommandEnvelope(command: .setSettings(EngineSettings())))
        #expect((empty["settings"] as? [String: Any])?.isEmpty == true)
    }

    @Test func helloCarriesTheGlobalPeerMode() throws {
        let defaults = UserDefaults(suiteName: "SessionWireTests.\(UUID().uuidString)")!
        // r2-peers: unset (or unknown) is `auto` — a message from another of the user's sessions runs as it arrives.
        #expect(AppSettings.peerInbound(defaults: defaults) == .auto)
        #expect(AppSettings.sessionEngineSettings(defaults: defaults).peerInbound == .auto)
        AppSettings.setPeerInbound(.off, defaults: defaults)
        #expect(AppSettings.sessionEngineSettings(defaults: defaults).peerInbound == .off)
        defaults.set("bogus", forKey: AppSettings.Key.peerInbound)
        #expect(AppSettings.peerInbound(defaults: defaults) == .auto)
        // Everything else is the plain hello payload.
        var plain = AppSettings.engineSettings(defaults: defaults)
        plain.peerInbound = .auto
        #expect(AppSettings.sessionEngineSettings(defaults: defaults) == plain)
    }
}
