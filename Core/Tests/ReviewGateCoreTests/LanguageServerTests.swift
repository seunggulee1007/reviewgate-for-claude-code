import Foundation
import Testing
@testable import ReviewGateCore

/// lsp: the language server for JS / TS / Vue on the Mac (docs/PROTOCOL.md §73) — the wire, the setting, the words.
@Suite @MainActor struct LanguageServerTests {
    @Test func repliesCarryTheSourceTheFallbackAndTheQuickInfo() throws {
        let lsp = #"{"type":"definitions","id":"d1","symbol":"add","candidates":[{"path":"src/math.ts","line":2,"column":17,"kind":"function","preview":"export function add(","score":1000}],"truncated":false,"source":"lsp","quickInfo":{"display":"function add(a: number): number","documentation":"Adds.","kind":"function"}}"#
        guard case let .definitions(d) = try JSONDecoder().decode(EngineEvent.self, from: Data(lsp.utf8)) else { Issue.record("not definitions"); return }
        #expect(d.source == .lsp && d.fallback == nil && d.quickInfo == LspQuickInfo(display: "function add(a: number): number", documentation: "Adds.", kind: "function"))

        let grep = #"{"type":"references","symbol":"add","hits":[],"files":0,"truncated":false,"source":"grep","fallback":"no_result"}"#
        guard case let .references(r) = try JSONDecoder().decode(EngineEvent.self, from: Data(grep.utf8)) else { Issue.record("not references"); return }
        #expect(r.source == .grep && r.fallback == .noResult)

        // An older engine: nothing of it (the search's answer); an unknown fallback or an empty quickInfo is dropped.
        let old = #"{"type":"definitions","symbol":"add","candidates":[],"truncated":false,"fallback":"brand-new","quickInfo":{"display":""}}"#
        guard case let .definitions(o) = try JSONDecoder().decode(EngineEvent.self, from: Data(old.utf8)) else { Issue.record("not definitions"); return }
        #expect(o.source == nil && o.fallback == nil && o.quickInfo == nil)
    }

    @Test func stateNavLspDecodesAndAnUnknownStatusIsIdle() throws {
        let json = #"{"index":{"status":"ready","files":3,"symbols":9,"truncated":false,"builtAt":null},"lsp":{"status":"starting","typescript":{"version":"6.0.3","source":"bundled"},"restarts":1}}"#
        let nav = try JSONDecoder().decode(NavState.self, from: Data(json.utf8))
        #expect(nav.lsp == LspState(status: .starting, typescript: .init(version: "6.0.3", source: "bundled"), restarts: 1))
        let unknown = try JSONDecoder().decode(NavState.self, from: Data(#"{"index":{"status":"idle"},"lsp":{"status":"warming"}}"#.utf8))
        #expect(unknown.lsp == nil && unknown.index.status == .idle)
    }

    @Test func theAppFollowsStarting() throws {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "LanguageServerTests.\(UUID().uuidString)")!)
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.nav = NavState(index: NavIndexState(status: .idle), lsp: LspState(status: .starting))
        app.handle(.state(s))
        #expect(app.navLspStarting)
        s.seq = 2
        s.nav = NavState(index: NavIndexState(status: .idle), lsp: LspState(status: .ready))
        app.handle(.state(s))
        #expect(!app.navLspStarting)
    }

    @Test func commandsAndSettingsEncode() throws {
        let ref = try JSONSerialization.jsonObject(with: JSONEncoder().encode(EngineCommand.findReferences(symbol: "add", fromPath: "a.ts", line: 3, column: 15))) as! [String: Any]
        #expect(ref["line"] as? Int == 3 && ref["column"] as? Int == 15)
        var settings = EngineSettings()
        settings.languageServer = false
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as! [String: Any]
        #expect(json["languageServer"] as? Bool == false)
        let defaults = UserDefaults(suiteName: "LanguageServerTests.\(UUID().uuidString)")!
        #expect(LanguageServerSetting.isOn(defaults))
        #expect(AppSettings.engineSettings(defaults: defaults).languageServer == true)
        defaults.set(false, forKey: LanguageServerSetting.defaultsKey)
        #expect(!LanguageServerSetting.isOn(defaults) && AppSettings.engineSettings(defaults: defaults).languageServer == false)
    }

    @Test func theBundleIsLookedForNextToTheSidecar() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-lsp-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let sidecar = dir.appendingPathComponent("dist/sidecar.mjs").path
        #expect(!LanguageServerSetting.bundled(sidecarPath: sidecar))
        let tsserver = dir.appendingPathComponent("dist/lsp/node_modules/typescript/lib")
        try FileManager.default.createDirectory(at: tsserver, withIntermediateDirectories: true)
        try Data().write(to: tsserver.appendingPathComponent("tsserver.js"))
        #expect(LanguageServerSetting.bundled(sidecarPath: sidecar))
    }

    @Test func exactOrEstimatedAndWhy() {
        #expect(NavSourceText.label(.lsp) != NavSourceText.label(.grep))
        #expect(NavSourceText.label(nil) == NavSourceText.label(.grep))   // an older engine: the search's
        let reasons = Set([LspFallback.starting, .timeout, .failed, .noResult, .off].map { NavSourceText.help(.grep, fallback: $0) } + [NavSourceText.help(.grep, fallback: nil), NavSourceText.help(.lsp, fallback: nil)])
        #expect(reasons.count == 7)
        #expect(NavSourceText.help(.grep, fallback: .failed) == NavSourceText.help(.grep, fallback: .unavailable))
    }
}
