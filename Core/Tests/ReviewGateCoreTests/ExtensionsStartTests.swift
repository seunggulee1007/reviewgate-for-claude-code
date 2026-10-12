import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 mac-session: a slow extensions start on the Mac (docs/PROTOCOL.md §36.7) — what the start waits for, "Extensions
/// off" after the fallback and `retry_extensions` (with the reopen of older engines), the banner shown once per project.
@Suite @MainActor struct ExtensionsStartTests {
    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ExtensionsStartTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, starting: Bool = false, ready: Bool = true, waiting: ExtensionsWaitingOn? = nil,
                          fallback: ExtensionsFallback? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        var ext = SessionExtensions(settingSources: fallback == nil ? ["user", "project", "local"] : ["project"])
        ext.fallback = fallback
        s.session = SessionInfo(open: true, starting: starting, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil,
                                canRestart: !starting, extensions: ext)
        s.session.ready = ready
        s.session.extensionsWaitingOn = waiting
        s.session.cli = CliInfo(version: "2.1.307", verified: true)
        s.gate = GateInfo(phase: .idle, canSend: !starting, canRequestChanges: false, blockedReason: starting ? .starting : nil,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    @Test func waitingTextNamesWhatTheStartWaitsFor() {
        #expect(ExtensionsStartText.waiting(ExtensionsWaitingOn(kind: .mcp, name: "serena")) == "Waiting for serena")
        #expect(ExtensionsStartText.waiting(ExtensionsWaitingOn(kind: .hook, name: "SessionStart")) == "Waiting for SessionStart")
        #expect(ExtensionsStartText.waiting(ExtensionsWaitingOn(kind: .hook, name: nil)) == "Waiting for a hook")
        #expect(ExtensionsStartText.waiting(ExtensionsWaitingOn(kind: .mcp, name: nil)) == "Waiting for an MCP server")
        #expect(ExtensionsStartText.waiting(ExtensionsWaitingOn(kind: .plugin, name: nil)) == "Waiting for a plugin")
        #expect(ExtensionsStartText.waiting(ExtensionsWaitingOn(kind: .unknown, name: nil)) == "Waiting for extensions")
        #expect(ExtensionsStartText.detail(ExtensionsWaitingOn(kind: .mcp, name: "serena")).contains("serena"))
        #expect(ExtensionsStartText.detail(ExtensionsWaitingOn(kind: .plugin, name: "team-plugin")).contains("team-plugin"))
    }

    @Test func waitingShowsOnlyWhileStarting() {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1, starting: false, ready: false, waiting: ExtensionsWaitingOn(kind: .mcp, name: "serena"))))
        #expect(store.extensionsWaitingOn?.name == "serena")
        // Initialized: a stale value is not shown.
        store.handle(.state(snapshot(seq: 2, ready: true, waiting: ExtensionsWaitingOn(kind: .mcp, name: "serena"))))
        #expect(store.extensionsWaitingOn == nil)
        store.handle(.state(snapshot(seq: 3, starting: true, ready: false)))
        #expect(store.extensionsWaitingOn == nil)
    }

    @Test func extensionsOffFollowsTheFallback() {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1)))
        #expect(store.extensionsOff == nil)
        let fallback = ExtensionsFallback(timeoutMs: 45_000, at: "2026-10-23T01:00:00.000Z")
        store.handle(.state(snapshot(seq: 2, fallback: fallback)))
        #expect(store.extensionsOff == fallback)
        // The banner can be closed; the chip stays.
        #expect(store.extensionsFallbackBanner != nil)
        store.dismissExtensionsFallback()
        store.sessionTools.silenceFallbackBanner()
        #expect(store.extensionsFallbackBanner == nil)
        #expect(store.extensionsOff == fallback)
        // The automatic retry that falls back again does not bring the closed banner back.
        let again = ExtensionsFallback(timeoutMs: 45_000, at: "2026-10-23T01:05:00.000Z")
        store.handle(.extensionsFallback(reason: "init_timeout", timeoutMs: 45_000, message: "restarted without them"))
        store.handle(.state(snapshot(seq: 3, fallback: again)))
        #expect(store.extensionsFallbackBanner == nil)
        #expect(store.extensionsOff == again)
    }

    @Test func retryUsesRetryExtensions() async {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1, fallback: ExtensionsFallback(timeoutMs: 45_000, at: "a"))))
        var sent: [EngineCommand] = []
        store.replySink = { command in
            sent.append(command)
            return .result(id: "r", ok: true, error: nil)
        }
        #expect(await store.sessionTools.retryExtensions() == .started)
        #expect(sent == [.retryExtensions])
        #expect(store.sessionTools.extensionsRetryError == nil)
        #expect(!store.sessionTools.isRetryingExtensions)
    }

    @Test func retryRefusalsAndOlderEngines() async {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1, fallback: ExtensionsFallback(timeoutMs: 45_000, at: "a"))))
        store.replySink = { _ in throw EngineClientError.refused("unknown command: retry_extensions", code: "unknown_command") }
        #expect(await store.sessionTools.retryExtensions() == .unsupported)   // the caller reopens the project instead
        store.replySink = { _ in throw EngineClientError.refused("no_session", code: "no_session") }
        #expect(await store.sessionTools.retryExtensions() == .unsupported)
        store.replySink = { _ in throw EngineClientError.refused("extensions_on", code: "extensions_on") }
        #expect(await store.sessionTools.retryExtensions() == .alreadyOn)
        #expect(store.sessionTools.extensionsRetryError == nil)
        store.replySink = { _ in throw EngineClientError.refused("session_busy", code: "session_busy") }
        #expect(await store.sessionTools.retryExtensions() == .refused)
        #expect(store.sessionTools.extensionsRetryError == EngineMessages.refusal(code: "session_busy", error: "session_busy"))
    }
}
