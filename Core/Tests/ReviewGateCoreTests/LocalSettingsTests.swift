import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 mac-session: local settings on the Mac (docs/PROTOCOL.md §36.6) — kept per project (default on), sent before
/// `open_project`, the restart notice when the choice differs from what the session applied, and what tells an engine that
/// knows §36 from an older one.
@Suite @MainActor struct LocalSettingsTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "LocalSettingsTests.\(UUID().uuidString)")! }

    private func snapshot(seq: Int, extensions: SessionExtensions?, cli: CliInfo? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil,
                                canRestart: true, extensions: extensions)
        s.session.cli = cli
        return s
    }

    @Test func choiceIsKeptPerProjectAndDefaultsToOn() {
        let d = defaults()
        #expect(AppSettings.loadLocalSettings(root: "/repo", defaults: d))
        AppSettings.setLoadLocalSettings(false, root: "/repo", defaults: d)
        #expect(!AppSettings.loadLocalSettings(root: "/repo", defaults: d))
        #expect(AppSettings.loadLocalSettings(root: "/other", defaults: d))
        AppSettings.setLoadLocalSettings(true, root: "/repo", defaults: d)
        #expect(AppSettings.loadLocalSettings(root: "/repo", defaults: d))
    }

    @Test func openProjectCarriesTheProjectsChoice() {
        let d = defaults()
        AppSettings.setLoadLocalSettings(false, root: "/work/acme", defaults: d)
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d)
        #expect(store.projectSessionSettings(for: URL(fileURLWithPath: "/work/acme")).loadLocalSettings == false)
        #expect(store.projectSessionSettings(for: URL(fileURLWithPath: "/work/acme/")).loadLocalSettings == false)   // one project key
        #expect(store.projectSessionSettings(for: URL(fileURLWithPath: "/work/other")).loadLocalSettings == true)
    }

    @Test func togglingStoresAndTellsTheEngine() {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        store.handle(.state(snapshot(seq: 1, extensions: SessionExtensions(settingSources: ["user", "project", "local"]))))
        #expect(store.loadsLocalSettingsForProject)
        store.setLoadsLocalSettingsForProject(false)
        #expect(!store.loadsLocalSettingsForProject)
        guard case let .setSettings(settings)? = sent.last else { Issue.record("no set_settings"); return }
        #expect(settings.loadLocalSettings == false)
        #expect(settings.permissionMode == nil && settings.budget == nil)   // only the one field
    }

    @Test func restartNoticeFollowsWhatTheSessionApplied() {
        let local = SessionExtensions(settingSources: ["user", "project", "local"])
        let without = SessionExtensions(settingSources: ["user", "project"])
        #expect(!LocalSettingsLogic.needsRestart(applied: local, wanted: true, supported: true))
        #expect(LocalSettingsLogic.needsRestart(applied: local, wanted: false, supported: true))
        #expect(LocalSettingsLogic.needsRestart(applied: without, wanted: true, supported: true))
        #expect(!LocalSettingsLogic.needsRestart(applied: without, wanted: false, supported: true))
        // An older engine never applies local: no notice it could not keep.
        #expect(!LocalSettingsLogic.needsRestart(applied: without, wanted: true, supported: false))
        // The §16 fallback drops local with user: the fallback banner / retry says it, not the restart notice.
        var fallback = without
        fallback.fallback = ExtensionsFallback(timeoutMs: 45_000)
        #expect(!LocalSettingsLogic.needsRestart(applied: fallback, wanted: true, supported: true))
        #expect(!LocalSettingsLogic.needsRestart(applied: nil, wanted: true, supported: true))
    }

    @Test func anEngineThatKnowsSection36IsRecognized() {
        var session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil)
        #expect(!SessionToolsSupport.knowsSessionTools(session))
        session.extensions = SessionExtensions(settingSources: ["user", "project"])
        #expect(!SessionToolsSupport.knowsSessionTools(session))   // an older engine: nothing of §36
        session.cli = CliInfo(version: "2.1.307", verified: true)
        #expect(SessionToolsSupport.knowsSessionTools(session))
        session.cli = nil
        session.extensions = SessionExtensions(settingSources: ["project", "local"])
        #expect(SessionToolsSupport.knowsSessionTools(session))
        session.extensions = SessionExtensions(settingSources: ["user", "project"])
        session.extensions?.notApplied = NotAppliedLocalSettings(envKeys: ["A"])
        #expect(SessionToolsSupport.knowsSessionTools(session))
        session.extensions?.notApplied = nil
        var caps = SessionCapabilities(slashCommands: [], skills: [], plugins: [], mcpServers: [])
        caps.state = .starting
        session.capabilities = caps
        #expect(SessionToolsSupport.knowsSessionTools(session))
    }

    @Test func storeSaysWhetherLocalAppliesAndWhatIsLeftOut() {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        store.commandSink = { _ in }
        var ext = SessionExtensions(settingSources: ["user", "project"])
        ext.notApplied = NotAppliedLocalSettings(hooks: [.init(event: "Stop", command: "on-stop.sh")], mcpServers: ["serena"])
        store.handle(.state(snapshot(seq: 1, extensions: ext, cli: CliInfo(version: "2.1.307", verified: true))))
        #expect(store.supportsSessionTools)
        #expect(store.localSettingsNeedRestart)   // on by default, not applied by this session
        store.setLoadsLocalSettingsForProject(false)
        #expect(!store.localSettingsNeedRestart)
        #expect(store.extensions?.notApplied?.mcpServers == ["serena"])
    }
}
