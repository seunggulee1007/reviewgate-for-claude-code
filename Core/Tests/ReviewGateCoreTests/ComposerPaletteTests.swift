import Foundation
import Testing
@testable import ReviewGateCore

/// r1-composer M14 (docs/PROTOCOL.md §36.5): the `/` palette and ⌘/ work while Claude works and while the session starts —
/// the next skill is picked from the list instead of typed from memory; a pick goes into the draft and ↩ then steers or
/// queues it like any message.
@Suite @MainActor struct ComposerPaletteTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ComposerPaletteTests.\(UUID().uuidString)")!)
    }

    private func snapshot(phase: GatePhase, starting: Bool = false, capabilities: SessionCapabilities?) -> ReviewState {
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: !starting, starting: starting, sessionId: "s", model: nil, capabilities: capabilities,
                                pendingPermission: nil, canRestart: true)
        let idle = phase == .idle || phase == .reviewing
        s.gate = GateInfo(phase: phase, canSend: idle && !starting, canRequestChanges: false,
                          blockedReason: starting ? .starting : (idle ? nil : .running), collectError: nil, pendingCount: 0,
                          changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: "A", turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    private var caps: SessionCapabilities {
        var caps = SessionCapabilities(slashCommands: ["acme-tools:review-reply", "compact"], skills: ["acme-tools:review-reply"],
                                       plugins: ["acme-tools"], mcpServers: [])
        caps.commands = [SlashCommandInfo(name: "acme-tools:review-reply", description: "Answer the review comments", argumentHint: "<pr>",
                                          source: .plugin, plugin: "acme-tools"),
                         SlashCommandInfo(name: "compact", description: "Compact the conversation", argumentHint: "", source: .builtin)]
        return caps
    }

    @Test func thePaletteWorksWhileClaudeWorks() {
        let app = makeState()
        app.handle(.state(snapshot(phase: .running, capabilities: caps)))
        #expect(!app.canSend)
        #expect(app.canUseSlashPalette)
        #expect(app.slashEntries.map(\.name).contains("acme-tools:review-reply"))
        #expect(app.slashPaletteEmptyState(shown: app.slashEntries) == nil)
    }

    @Test func whileTheSessionStartsThePaletteSaysSo() {
        let app = makeState()
        app.handle(.state(snapshot(phase: .idle, starting: true, capabilities: nil)))
        #expect(!app.canSend && app.canUseSlashPalette)
        #expect(app.slashPaletteEmptyState(shown: []) == .starting)
    }

    @Test func withoutAProjectThereIsNoPalette() {
        let app = makeState()
        #expect(!app.canUseSlashPalette)
    }
}
