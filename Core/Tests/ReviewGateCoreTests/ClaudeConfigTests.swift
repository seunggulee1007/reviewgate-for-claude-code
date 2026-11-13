import Foundation
import Testing
@testable import ReviewGateCore

/// wave4d w4d-config: MCP servers' origins, the choice for every worktree, the login wait, Claude's instruction files and
/// the CLAUDE.md editor on the Mac (docs/PROTOCOL.md §42.3).
@Suite @MainActor struct ClaudeConfigTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test func serverOriginDecodesLenientlyAndDecidesTheRemoveScope() throws {
        let parent = try decode(McpServerInfo.self, #"""
        {"name":"context7","status":"connected","scope":"project","source":"project","transport":"stdio","toolCount":2,"tools":[],
         "error":null,"serverInfo":null,"config":null,"disabledByUser":false,"sessionAdded":false,
         "origin":{"file":"/w/workspace/.mcp.json","place":"parent","removable":true},"authWaiting":true}
        """#)
        #expect(parent.origin == McpServerOrigin(file: "/w/workspace/.mcp.json", place: .parent, removable: true))
        #expect(parent.isFromParentFolder)
        #expect(parent.removeScope == .project)
        #expect(parent.authWaiting)
        let blocked = try decode(McpServerInfo.self, #"""
        {"name":"ghost","status":"failed","source":"project","origin":{"file":null,"place":null,"removable":false,"reason":"not_found",
         "command":"claude mcp remove --scope project ghost"},"disabledByUser":true,"disabledIn":"repository","status2":1}
        """#)
        #expect(blocked.removeScope == nil)
        #expect(blocked.isOffForRepository)
        #expect(McpOriginText.notRemovable(blocked) != nil)
        #expect(McpOriginText.terminalHint(blocked)?.contains("claude mcp remove --scope project ghost") == true)
        #expect(McpText.removeExplanation(blocked) == McpOriginText.notRemovable(blocked))
        // An older engine: no origin — the source decides as before; a bad origin is dropped, not fatal.
        let old = try decode(McpServerInfo.self, #"{"name":"x","status":"connected","source":"user","origin":"nope"}"#)
        #expect(old.origin == nil)
        #expect(old.removeScope == .user)
        #expect(!old.authWaiting)
        #expect(McpOriginText.line(old) == nil)
        #expect(McpOriginText.line(parent)?.contains("/w/workspace/.mcp.json") == true)
        #expect(McpText.removeExplanation(parent).contains("/w/workspace/.mcp.json"))
    }

    @Test func storeOffersTheRepositoryChoiceOnlyWithAnEngineThatReportsOrigins() throws {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ClaudeConfigTests.\(UUID().uuidString)")!)
        store.mcp.apply(servers: [McpServerInfo(name: "a", status: .connected, source: .user)], restartRequired: false)
        #expect(!store.mcp.supportsRepositoryToggle)
        var b = McpServerInfo(name: "b", status: .connected, source: .project)
        b.origin = McpServerOrigin(file: "/r/.mcp.json", place: .project, removable: true)
        store.mcp.apply(servers: [b], restartRequired: false)
        #expect(store.mcp.supportsRepositoryToggle)
    }

    @Test func aSavedConfigFileOpenedFromTheListNeedsARestart() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mcp-open-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let file = McpConfigFile.projectFile(root: dir)
        #expect(file.hasSuffix("/.mcp.json"))
        #expect(McpConfigFile.createEmpty(at: file))
        #expect(try String(contentsOfFile: file, encoding: .utf8) == McpConfigFile.emptyMcpJson)
        // An existing file is never overwritten.
        try "{\"mcpServers\": {\"a\": {}}}".write(toFile: file, atomically: true, encoding: .utf8)
        #expect(McpConfigFile.createEmpty(at: file))
        #expect(try String(contentsOfFile: file, encoding: .utf8).contains("\"a\""))

        let mcp = McpStore()
        mcp.configOpened(file)
        #expect(!mcp.checkConfigEdited())
        #expect(!mcp.needsRestart)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(60)], ofItemAtPath: file)
        #expect(mcp.checkConfigEdited())
        #expect(mcp.needsRestart)
        #expect(!mcp.checkConfigEdited())   // the save is counted once
        mcp.configRestarted()
        #expect(!mcp.needsRestart)
        #expect(McpConfigFile.isHomeConfig("/Users/dev/.claude.json"))
        #expect(!McpConfigFile.isHomeConfig("/work/acme/.mcp.json"))
    }

    @Test func commandsEncodeTheNewFields() throws {
        func json(_ cmd: EngineCommand) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(cmd)) as! [String: Any]
        }
        let toggle = try json(.mcpToggleScoped(name: "github", enabled: false, repository: true))
        #expect(toggle["type"] as? String == "mcp_toggle")
        #expect(toggle["scope"] as? String == "repository")
        #expect(toggle["enabled"] as? Bool == false)
        let remove = try json(.mcpRemoveFile(name: "c7", scope: .project, file: "/w/.mcp.json"))
        #expect(remove["type"] as? String == "mcp_remove")
        #expect(remove["file"] as? String == "/w/.mcp.json")
        let create = try json(.claudeMdWrite(path: "CLAUDE.md", text: "# x", baseSha: nil))
        #expect(create["type"] as? String == "claude_md_write")
        #expect(create["baseSha"] is NSNull)
        let read = try json(.claudeMdRead(path: "CLAUDE.md"))
        #expect(read["type"] as? String == "claude_md_read")
    }

    @Test func extensionsDecodeProjectFilesAgentsAndMemoryKinds() throws {
        let ext = try decode(SessionExtensions.self, #"""
        {"settingSources":["user","project"],"plugins":[],"skills":[],"slashCommands":[],"mcpServers":[],
         "memoryFiles":[{"path":"/r/CLAUDE.md","type":"Project","tokens":10,"kind":"project","editable":true},{"path":"/h/.claude/CLAUDE.md","type":"User"}],
         "claudeMd":{"user":true,"project":true,"source":"cli"},"hooks":[],
         "projectInstructions":[{"path":"/r/CLAUDE.md","relPath":"CLAUDE.md","kind":"project","exists":true},{"bad":1}],
         "agents":[{"name":"executor","description":"Implements.","model":"sonnet","source":"plugin","path":"/p/agents/executor.md"},{"name":""}]}
        """#)
        #expect(ext.memoryFiles?.first?.kind == "project")
        #expect(ext.memoryFiles?.first?.editable == true)
        #expect(ext.memoryFiles?.last?.kind == nil)
        #expect(ext.projectInstructions == [ProjectInstructionFile(path: "/r/CLAUDE.md", relPath: "CLAUDE.md", kind: "project", exists: true)])
        #expect(ext.agents == [SubagentInfo(name: "executor", description: "Implements.", model: "sonnet", source: "plugin", path: "/p/agents/executor.md")])
        let older = try decode(SessionExtensions.self, #"{"settingSources":["project"]}"#)
        #expect(older.projectInstructions == nil)
        #expect(older.agents == nil)
    }

    @Test func kindsWordWhenClaudeReadsThem() {
        #expect(InstructionKind(lenient: "auto_memory") == .autoMemory)
        #expect(InstructionKind(lenient: "nope") == .other)
        #expect(InstructionKind(lenient: nil) == .other)
        for kind in InstructionKind.allCases { #expect(!InstructionText.whenRead(kind).isEmpty) }
        #expect(InstructionText.whenRead(.nested) != InstructionText.whenRead(.project))
        #expect(!InstructionText.canOpen("/bin/ls"))
        #expect(!InstructionText.canOpen("/nonexistent/CLAUDE.md"))
        #expect(!InstructionText.canOpen(nil))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-claudecfg-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let md = dir.appendingPathComponent("CLAUDE.md")
        try? "x".write(to: md, atomically: true, encoding: .utf8)
        #expect(InstructionText.canOpen(md.path))
        let app = dir.appendingPathComponent("Evil.md.app")
        try? FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
        #expect(!InstructionText.canOpen(app.path))
    }

    @Test func diffKeepsContextAroundChangesAndFoldsTheRest() {
        let old = (1...20).map { "line \($0)" }.joined(separator: "\n") + "\n"
        var lines = (1...20).map { "line \($0)" }
        lines[9] = "line 10 changed"
        lines.append("line 21")
        let new = lines.joined(separator: "\n") + "\n"
        let diff = InstructionDiff.lines(old: old, new: new, context: 2)
        #expect(diff.first == InstructionDiffLine(id: 0, kind: .hunkHeader, text: "", folded: 7))
        #expect(diff.filter { $0.kind == .del }.map(\.text) == ["line 10"])
        #expect(diff.filter { $0.kind == .add }.map(\.text) == ["line 10 changed", "line 21"])
        #expect(InstructionDiff.counts(diff) == (added: 2, removed: 1))
        #expect(diff.contains { $0.kind == .hunkHeader && $0.folded == 6 })
        #expect(InstructionDiff.lines(old: "a\n", new: "a\n").isEmpty)
        #expect(InstructionDiff.lines(old: "", new: "# Rules\n").map(\.kind) == [.add])
    }

    @Test func editorReadsConfirmsAndSavesOverWhatWasRead() async {
        var sent: [EngineCommand] = []
        let editor = InstructionEditor(app: nil, path: "CLAUDE.md")
        var failNext: String?
        editor.send = { cmd in
            sent.append(cmd)
            if let code = failNext {
                failNext = nil
                throw EngineClientError.refused(code, code: code)
            }
            switch cmd {
            case .claudeMdRead: return .claudeMd(ClaudeMdReply(path: "/r/CLAUDE.md", relPath: "CLAUDE.md", text: "a\n", sha: "s1", exists: true))
            case let .claudeMdWrite(_, text, _): return .claudeMd(ClaudeMdReply(path: "/r/CLAUDE.md", relPath: "CLAUDE.md", text: text, sha: "s2", exists: true, saved: true))
            default: throw EngineClientError.stopped
            }
        }
        await editor.load()
        #expect(editor.phase == .editing)
        editor.confirm()
        #expect(editor.phase == .editing)   // nothing changed: nothing to confirm
        editor.text = "a\nb\n"
        editor.confirm()
        #expect(editor.phase == .confirming)
        #expect(InstructionDiff.counts(editor.diff) == (added: 1, removed: 0))
        failNext = "claude_md_changed"
        #expect(await editor.save() == false)
        #expect(editor.stale)
        #expect(editor.errorText == InstructionText.refusal(code: "claude_md_changed", fallback: ""))
        #expect(await editor.save())
        #expect(editor.phase == .saved)
        #expect(editor.file?.sha == "s2")
        guard case let .claudeMdWrite(path, text, base) = sent.last else { Issue.record("no write"); return }
        #expect(path == "CLAUDE.md" && text == "a\nb\n" && base == "s1")
    }
}
