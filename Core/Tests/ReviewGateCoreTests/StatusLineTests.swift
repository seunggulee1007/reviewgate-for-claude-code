import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: wave6 w6-statusline — §44.2: `status_line` as the engine really sends it (`engine/test/fixtures/wire/
/// wave6.statusline.json`, written by engine.statusLine.test.ts), the command, the store and the two settings.
@Suite @MainActor struct StatusLineTests {
    private static let fixture: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("engine/test/fixtures/wire/wave6.statusline.json")
    }()

    private func golden(_ key: String) throws -> EngineEvent {
        let data = try Data(contentsOf: Self.fixture)
        let all = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let object = try #require(all[key])
        let line = try JSONSerialization.data(withJSONObject: object)
        return try NDJSON.decode(EngineEvent.self, from: String(decoding: line, as: UTF8.self))
    }

    private func reply(_ key: String) throws -> StatusLineReply {
        guard case let .statusLine(r) = try golden(key) else { Issue.record("\(key) is not a status_line"); return StatusLineReply() }
        return r
    }

    @Test func theEnginesEventsDecode() throws {
        let first = try reply("reply")
        #expect(try golden("reply").replyId == "sl-1")
        #expect(first.lines.isEmpty && first.updatedAt == nil && first.enabled && first.configured)
        #expect(first.source == "user" && first.command == "~/.claude/statusline.sh" && first.path == "/home/me/.claude/settings.json" && first.padding == 1)

        let update = try reply("update")
        #expect(update.id == nil)
        #expect(update.lines.count == 2)
        #expect(update.updatedAt == "2023-11-14T22:13:20.000Z")
        let runs = AnsiText.parseLines(update.lines)
        #expect(runs[0].first == AnsiRun("Opus 5.5", AnsiStyle(bold: true)))
        #expect(runs[0].contains(AnsiRun("v2.1.310", AnsiStyle(fg: .index(214)))))
        #expect(runs[1].first == AnsiRun("PR #1", AnsiStyle(link: "https://example.com/pr/1")))

        let failed = try reply("failed")
        #expect(failed.lines == update.lines)
        #expect(failed.error == StatusLineFailure(code: "exit", message: "statusline: jq not found", at: "2023-11-14T22:13:20.000Z", exitCode: 127))

        let off = try reply("off")
        #expect(!off.enabled && off.lines.isEmpty && off.configured)
    }

    @Test func aProjectsDefinitionAndTheHooksOffDecode() throws {
        let line = #"{"type":"status_line","lines":["x",7],"updatedAt":null,"enabled":true,"configured":false,"padding":99,"project":{"path":"/r/.claude/settings.json","command":"./sl.sh","sha256":"ab12","allowed":false},"disabled":"disable_all_hooks"}"#
        guard case let .statusLine(r) = try NDJSON.decode(EngineEvent.self, from: line) else { Issue.record("not decoded"); return }
        #expect(r.lines == ["x"])   // an element of another type is dropped
        #expect(r.padding == 20)
        #expect(r.project == StatusLineProjectDefinition(path: "/r/.claude/settings.json", command: "./sl.sh", sha256: "ab12", allowed: false))
        #expect(r.disabled == "disable_all_hooks")
        let managed = #"{"type":"status_line","lines":[],"enabled":true,"configured":false,"padding":0,"project":{"path":"/r/.claude/settings.json","command":"./sl.sh","allowed":false},"disabled":"managed_policy"}"#
        guard case let .statusLine(m) = try NDJSON.decode(EngineEvent.self, from: managed) else { Issue.record("not decoded"); return }
        #expect(m.disabled == "managed_policy")
        #expect(m.project?.sha256 == "")   // an engine before the sha256
    }

    @Test func theCommandCarriesTheWidthAndVisibility() throws {
        func json(_ cmd: EngineCommand) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(cmd)) as! [String: Any]
        }
        let full = try json(.statusLine(columns: 96, visible: true))
        #expect(full["type"] as? String == "status_line" && full["columns"] as? Int == 96 && full["visible"] as? Bool == true)
        #expect(try json(.statusLine(columns: nil, visible: false)).count == 2)
    }

    @Test func theStoreShowsLinesOnlyWhileOnAndConfigured() async throws {
        let store = StatusLineStore()
        var sent: [EngineCommand] = []
        let update = try reply("update")
        await store.tell(columns: 100, visible: true) { cmd in
            sent.append(cmd)
            return .statusLine(update)
        }
        #expect(store.shownRuns.count == 2)
        #expect(store.padding == 1)
        #expect(store.columns == 100)   // the lines are cut to the width last measured
        // The same width and visibility are not told twice; another width is.
        await store.tell(columns: 100, visible: true) { cmd in sent.append(cmd); return .statusLine(update) }
        await store.tell(columns: 80, visible: true) { cmd in sent.append(cmd); return .statusLine(update) }
        #expect(sent == [.statusLine(columns: 100, visible: true), .statusLine(columns: 80, visible: true)])
        // Gone before it was measured: only the visibility goes; the width last measured stays.
        await store.tell(columns: 0, visible: false) { cmd in sent.append(cmd); return .statusLine(update) }
        #expect(sent.last == .statusLine(columns: nil, visible: false))
        #expect(store.columns == 80)
        sent.removeLast()
        store.apply(try reply("off"))
        #expect(store.shownRuns.isEmpty)
        var notConfigured = update
        notConfigured.configured = false
        store.apply(notConfigured)
        #expect(store.shownRuns.isEmpty)
        store.reset()
        #expect(store.reply == nil && store.runs.isEmpty)
        // An older engine: asked once, never again.
        await store.tell(columns: 90, visible: true) { _ in throw EngineClientError.refused("unknown command: status_line", code: "unknown_command") }
        #expect(store.unsupported)
        await store.tell(columns: 70, visible: true) { cmd in sent.append(cmd); return .statusLine(update) }
        #expect(sent.count == 2)
        #expect(store.columns == 70)   // measured all the same
    }

    @Test func theSettingsGoWithHelloAndLive() {
        let defaults = UserDefaults(suiteName: "StatusLineTests.settings.\(UUID().uuidString)")!
        #expect(AppSettings.engineSettings(defaults: defaults).showStatusLine == true)
        #expect(AppSettings.engineSettings(defaults: defaults).allowedProjectStatusLine == "")   // per project, before open_project
        defaults.set(false, forKey: AppSettings.Key.showStatusLine)
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.pushStatusLineSettings()
        var expected = EngineSettings()
        expected.showStatusLine = false
        expected.allowedProjectStatusLine = ""
        #expect(sent == [.setSettings(expected)])
        #expect(AppSettings.engineSettings(defaults: defaults).showStatusLine == false)
    }

    @Test func aProjectsOwnStatusLineIsAllowedPerProjectByItsCommand() {
        let defaults = UserDefaults(suiteName: "StatusLineTests.project.\(UUID().uuidString)")!
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        var state = ReviewState.empty
        state.seq = 1
        state.project = ProjectInfo(path: "/work/repo", root: "/work/repo", name: "repo", branch: "main", remoteURL: nil)
        app.handle(.state(state))
        let path = "/work/repo/.claude/settings.json"
        let sha = String(repeating: "a", count: 64)
        app.statusLine.apply(StatusLineReply(project: StatusLineProjectDefinition(path: path, command: "./sl.sh", sha256: sha, allowed: false)))
        #expect(!app.projectStatusLineAllowed && !app.projectStatusLineChanged)
        app.setProjectStatusLineAllowed(true)
        #expect(app.projectStatusLineAllowed && app.allowedProjectStatusLine == sha)
        guard case let .setSettings(on)? = sent.last else { Issue.record("no set_settings"); return }
        #expect(on.allowedProjectStatusLine == sha && on.showStatusLine == true)
        // Kept per project and sent before each open_project — never the last project's.
        #expect(app.projectSessionSettings(for: URL(fileURLWithPath: "/work/repo")).allowedProjectStatusLine == sha)
        #expect(app.projectSessionSettings(for: URL(fileURLWithPath: "/work/other")).allowedProjectStatusLine == "")
        // A pull changes the command: no longer the one allowed, so it is asked again.
        app.statusLine.apply(StatusLineReply(project: StatusLineProjectDefinition(path: path, command: "./sl.sh --upload", sha256: String(repeating: "b", count: 64), allowed: false)))
        #expect(!app.projectStatusLineAllowed && app.projectStatusLineChanged)
        app.setProjectStatusLineAllowed(false)
        #expect(!app.projectStatusLineChanged && app.allowedProjectStatusLine == "")
        guard case let .setSettings(off)? = sent.last else { Issue.record("no set_settings"); return }
        #expect(off.allowedProjectStatusLine == "")
    }

    @Test func anUndecodableLineIsLoggedByItsTypeAndSizeNeverItsContent() {
        let line = #"{"type":"status_line","command":"curl -H 'Authorization: Bearer secret-token' x","lines":["#   // cut off
        do {
            _ = try NDJSON.decode(EngineEvent.self, from: line)
            Issue.record("a cut line decoded")
        } catch {
            let said = NDJSON.undecodableSummary(line, error: error)
            #expect(said.hasPrefix("undecodable sidecar line (status_line, \(line.utf8.count) bytes): dataCorrupted"))
            #expect(!said.contains("secret-token") && !said.contains("curl"))
        }
        #expect(NDJSON.undecodableSummary("not json at all", error: CocoaError(.coderReadCorrupt)).hasPrefix("undecodable sidecar line (?, 15 bytes): "))
    }
}
