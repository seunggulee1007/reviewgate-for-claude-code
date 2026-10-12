import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 mac-session: docs/PROTOCOL.md §36.5–36.9 on the wire — the JSON examples of §36, the lenient reading of every new
/// field (an engine before §36 sends none of them), the new events and commands.
@Suite struct SessionToolsWireTests {
    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(id: "q1", command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func event(_ line: String) throws -> EngineEvent { try NDJSON.decode(EngineEvent.self, from: line) }

    // MARK: - §36.5 capabilities.commands / state

    @Test func capabilitiesCarryCommandsAndState() throws {
        // The §36.5 example.
        let caps = try NDJSON.decode(SessionCapabilities.self, from: #"""
        {"slashCommands":["mcp","team-plugin:team-dev"],"skills":["team-plugin:team-dev"],"plugins":["team-plugin"],"mcpServers":[],"state":"ready",
         "commands":[{"name":"mcp","description":"Manage MCP servers","argumentHint":"[reconnect|enable|disable [<server>|all]]","source":"builtin"},
                     {"name":"team-plugin:team-dev","description":"이슈 기반 개발","argumentHint":"<이슈 번호>","source":"plugin","plugin":"team-plugin"}]}
        """#)
        #expect(caps.state == .ready)
        #expect(!caps.isStarting)
        #expect(caps.commands.map(\.name) == ["mcp", "team-plugin:team-dev"])
        #expect(caps.commands[0].source == .builtin)
        #expect(caps.commands[0].argumentHint == "[reconnect|enable|disable [<server>|all]]")
        #expect(caps.commands[1].source == .plugin)
        #expect(caps.commands[1].plugin == "team-plugin")
        #expect(caps.commands[1].description == "이슈 기반 개발")
        #expect(caps.slashCommands == ["mcp", "team-plugin:team-dev"])   // the names stay as they are
    }

    @Test func oddCommandsNeverHideTheRest() throws {
        let caps = try NDJSON.decode(SessionCapabilities.self, from: #"""
        {"slashCommands":[],"skills":[],"plugins":[],"mcpServers":[],"state":"warming",
         "commands":[{"name":"/review","description":null,"source":"galaxy","aliases":["r"]},
                     {"description":"no name"},
                     42,
                     {"name":"github:create","source":"mcp","server":"github","argumentHint":7}]}
        """#)
        #expect(caps.state == nil)                                  // an unknown state reads as absent (= ready)
        #expect(caps.commands.map(\.name) == ["review", "github:create"])   // leading slash dropped, odd entries skipped
        #expect(caps.commands[0].source == .unknown)
        #expect(caps.commands[0].description == "")
        #expect(caps.commands[0].aliases == ["r"])
        #expect(caps.commands[1].server == "github")
        #expect(caps.commands[1].argumentHint == "")
    }

    @Test func olderCapabilitiesAndTheCacheRoundTrip() throws {
        let old = try NDJSON.decode(SessionCapabilities.self, from: #"{"slashCommands":["a"],"skills":[],"plugins":[],"mcpServers":[]}"#)
        #expect(old.commands.isEmpty)
        #expect(old.state == nil)
        // The UserDefaults cache keeps the descriptions (and stays as before without them).
        var caps = SessionCapabilities(slashCommands: ["x"], skills: [], plugins: [], mcpServers: [])
        caps.commands = [SlashCommandInfo(name: "x", description: "Does x", argumentHint: "<n>", source: .user)]
        caps.state = .starting
        let data = try JSONEncoder().encode(caps)
        let back = try JSONDecoder().decode(SessionCapabilities.self, from: data)
        #expect(back == caps)
        #expect(back.isStarting)
        let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any]
        #expect(plain?["commands"] == nil && plain?["state"] == nil)
        // Equality sees the new fields.
        var other = caps
        other.commands = []
        #expect(other != caps)
    }

    // MARK: - §36.6 local settings

    @Test func extensionsSayWhatLocalSettingsHold() throws {
        let ext = try NDJSON.decode(SessionExtensions.self, from: #"""
        {"settingSources":["user","project"],"fallback":null,"plugins":[],"disabledPlugins":[],"unresolvedDisabledPlugins":[],
         "userHooksDisabled":false,"skills":[],"slashCommands":[],"mcpServers":[],"memoryFiles":null,
         "claudeMd":{"user":true,"project":true,"source":"cli"},"hooks":[],
         "notApplied":{"hooks":[{"event":"Stop","command":"~/bin/on-stop.sh"},{"event":7}],"envKeys":["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"],
                       "mcpServers":["notes","serena"],"allowRuleCount":42}}
        """#)
        #expect(!ext.loadsLocalSettings)
        let notApplied = try #require(ext.notApplied)
        #expect(notApplied.hooks.first == NotAppliedLocalSettings.Hook(event: "Stop", command: "~/bin/on-stop.sh"))
        #expect(notApplied.hooks.count == 1)   // a hook without event and command is skipped, the rest stays
        #expect(notApplied.envKeys == ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"])
        #expect(notApplied.mcpServers == ["notes", "serena"])
        #expect(notApplied.allowRuleCount == 42)

        let loaded = try NDJSON.decode(SessionExtensions.self, from: #"{"settingSources":["user","project","local"],"notApplied":null}"#)
        #expect(loaded.loadsLocalSettings)
        #expect(loaded.notApplied == nil)
        let empty = try NDJSON.decode(SessionExtensions.self, from: #"{"settingSources":["project"],"notApplied":{"hooks":[],"envKeys":[],"mcpServers":[],"allowRuleCount":0}}"#)
        #expect(empty.notApplied == nil)   // nothing worth a section
        let old = try NDJSON.decode(SessionExtensions.self, from: #"{"settingSources":["user","project"]}"#)
        #expect(old.notApplied == nil && !old.loadsLocalSettings)
    }

    // MARK: - §36.7 / §36.8 session fields

    @Test func sessionCarriesCliAndWaitingOn() throws {
        let session = try NDJSON.decode(SessionInfo.self, from: #"""
        {"open":true,"starting":true,"sessionId":"s","model":null,"capabilities":{"slashCommands":[],"skills":[],"plugins":[],"mcpServers":[],"state":"starting"},
         "capabilitiesCached":true,"pendingPermission":null,
         "extensionsWaitingOn":{"kind":"mcp","name":"serena"},
         "cli":{"version":"2.1.308","verified":false,"verifiedRange":{"min":"2.1.300","max":"2.1.307"},
                "previous":{"version":"2.1.307","path":"/Users/me/.local/share/claude/versions/2.1.307"}}}
        """#)
        #expect(session.extensionsWaitingOn == ExtensionsWaitingOn(kind: .mcp, name: "serena"))
        #expect(session.capabilitiesCached)
        #expect(session.capabilities?.isStarting == true)
        let cli = try #require(session.cli)
        #expect(cli.version == "2.1.308")
        #expect(cli.isUnverified)
        #expect(cli.verifiedRange == CliVersionRange(min: "2.1.300", max: "2.1.307"))
        #expect(cli.previous == CliPreviousVersion(version: "2.1.307", path: "/Users/me/.local/share/claude/versions/2.1.307"))

        let odd = try NDJSON.decode(SessionInfo.self, from: #"""
        {"open":true,"starting":false,"extensionsWaitingOn":{"kind":"daemon","name":"  "},
         "cli":{"version":null,"verifiedRange":{"min":"1"},"previous":{"version":"2.1.1","path":null}}}
        """#)
        #expect(odd.extensionsWaitingOn == ExtensionsWaitingOn(kind: .unknown, name: nil))
        #expect(odd.cli?.version == nil)
        #expect(odd.cli?.verified == true)             // unreadable → no banner
        #expect(odd.cli?.isUnverified == false)
        #expect(odd.cli?.verifiedRange == nil)
        #expect(odd.cli?.previous == CliPreviousVersion(version: "2.1.1", path: nil))
        #expect(!odd.capabilitiesCached)

        let old = try NDJSON.decode(SessionInfo.self, from: #"{"open":false,"starting":false}"#)
        #expect(old.cli == nil && old.extensionsWaitingOn == nil && !old.capabilitiesCached)
    }

    @Test func versionNoticeCarriesTheChange() throws {
        // The §36.8 example.
        let ev = try event(#"""
        {"type":"error","message":"Claude Code changed from 2.1.307 to 2.1.308 (not verified yet).","fatal":false,"scope":"session",
         "code":"cli_version_changed","cli":{"from":"2.1.307","to":"2.1.308","verified":false}}
        """#)
        guard case let .error(_, fatal, scope, detail) = ev else { Issue.record("not an error"); return }
        #expect(!fatal && scope == .session)
        #expect(detail.code == "cli_version_changed")
        #expect(detail.cli == CliVersionChange(from: "2.1.307", to: "2.1.308", verified: false))
        guard case let .error(_, _, _, plain) = try event(#"{"type":"error","message":"x","fatal":false,"scope":"session","cli":"odd"}"#) else {
            Issue.record("not an error"); return
        }
        #expect(plain.cli == nil)
    }

    @Test func cliVersionsReply() throws {
        let ev = try event(#"""
        {"type":"cli_versions","id":"v1","versions":[
          {"version":"2.1.308","path":"/Users/me/.local/share/claude/versions/2.1.308","verified":false},
          {"path":""},
          {"version":"2.1.307","path":"/Users/me/.local/share/claude/versions/2.1.307","verified":true}],
         "current":"2.1.308","pinnedPath":null}
        """#)
        guard case let .cliVersions(reply) = ev else { Issue.record("not cli_versions"); return }
        #expect(ev.replyId == "v1")
        #expect(reply.versions.map(\.version) == ["2.1.308", "2.1.307"])
        #expect(reply.versions[1].verified)
        #expect(reply.current == "2.1.308")
        #expect(reply.pinnedPath == nil)
    }

    // MARK: - §36.9 other sessions

    @Test func cliSessionsReply() throws {
        // The §36.9 example plus odd entries.
        let ev = try event(#"""
        {"type":"cli_sessions","id":"q3","running":[{"pid":82411,"sessionId":"5d0c","name":"acme-b4","cwd":"/Users/me/acme",
         "status":"waiting","entrypoint":"cli","sameWorktree":true},{"name":"no pid"},{"pid":9,"cwd":"/Users/me/acme-4790","status":"sleeping"}],
         "resumable":[{"sessionId":"9f1e","title":"장바구니 합계 수정","updatedAt":"2026-10-23T02:10:00.000Z","cwd":"/Users/me/acme-4790"},{"title":"no id"}]}
        """#)
        guard case let .cliSessions(reply) = ev else { Issue.record("not cli_sessions"); return }
        #expect(ev.replyId == "q3")
        #expect(reply.running.map(\.pid) == [82411, 9])
        #expect(reply.running[0] == CliRunningSession(pid: 82411, sessionId: "5d0c", name: "acme-b4", cwd: "/Users/me/acme",
                                                      status: .waiting, entrypoint: "cli", sameWorktree: true))
        #expect(reply.running[0].isTerminal)
        #expect(reply.running[1].status == .unknown)
        #expect(reply.running[1].isTerminal)   // no entrypoint: treated as a terminal
        #expect(reply.resumable.map(\.sessionId) == ["9f1e"])
        #expect(reply.resumable[0].updatedDate != nil)
    }

    @Test func importedChatMeta() throws {
        let meta = try NDJSON.decode(SessionMeta.self, from: #"{"id":"c1","title":"주문","cliKnown":true,"imported":{"at":"2026-10-23T03:00:00.000Z","cwd":"/Users/me/acme"}}"#)
        #expect(meta.imported == ImportedSession(at: "2026-10-23T03:00:00.000Z", cwd: "/Users/me/acme"))
        #expect(meta.imported?.date != nil)
        #expect(try NDJSON.decode(SessionMeta.self, from: #"{"id":"c1"}"#).imported == nil)
        #expect(try NDJSON.decode(SessionMeta.self, from: #"{"id":"c1","imported":true}"#).imported == nil)
        let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(meta)) as? [String: Any]
        #expect((wire?["imported"] as? [String: Any])?["cwd"] as? String == "/Users/me/acme")
    }

    // MARK: - Commands and settings

    @Test func encodesTheNewCommands() throws {
        #expect(try json(.retryExtensions)["type"] as? String == "retry_extensions")
        #expect(try json(.cliVersions)["type"] as? String == "cli_versions")
        #expect(try json(.cliSessions)["type"] as? String == "cli_sessions")
        let imported = try json(.cliSessionImport(sessionId: "9f1e"))
        #expect(imported["type"] as? String == "cli_session_import")
        #expect(imported["sessionId"] as? String == "9f1e")
        #expect(imported["id"] as? String == "q1")   // the reply id stays the envelope's
        let add = try json(.mcpAdd(name: "serena", scope: .local, config: .stdio(command: "uvx", args: ["serena"])))
        #expect(add["scope"] as? String == "local")
        let remove = try json(.mcpRemove(name: "serena", scope: .local))
        #expect(remove["scope"] as? String == "local")
        var settings = EngineSettings()
        settings.loadLocalSettings = false
        let set = try json(.setSettings(settings))
        #expect((set["settings"] as? [String: Any])?["loadLocalSettings"] as? Bool == false)
        #expect(try json(.setSettings(EngineSettings()))["settings"].flatMap { ($0 as? [String: Any])?["loadLocalSettings"] } == nil)
    }

    @Test func localServersAreRemovableWithTheirScope() {
        #expect(McpSource.local.removableScope == .local)
        #expect(McpScope.allCases.contains(.local))
    }
}
