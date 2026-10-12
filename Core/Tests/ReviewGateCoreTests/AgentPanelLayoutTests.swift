import Foundation
import Testing
@testable import ReviewGateCore

/// wave4d w4d-agents2: docs/PROTOCOL.md §42.4 — the agent panel's identity colors, the plugin badge, how loud a card's
/// border is, and when parallel agents become rows.
@Suite struct AgentPanelLayoutTests {
    @Test func identityColorsAreStableAndApartForTheCommonTypes() {
        // The same numbers Electron's test expects.
        let want: [String: Int] = ["executor": 3, "architect": 2, "Explore": 5, "general-purpose": 6, "test-engineer": 4, "debugger": 1, "code-reviewer": 0, "analyst": 7]
        for (type, index) in want { #expect(AgentIdentity.colorIndex(type) == index, "\(type)") }
        // The plugin prefix does not change the color.
        #expect(AgentIdentity.colorIndex("oh-my-claudecode:executor") == AgentIdentity.colorIndex("executor"))
        #expect(Set(["executor", "architect", "Explore", "general-purpose"].map(AgentIdentity.colorIndex)).count == 4)
        #expect((0..<AgentIdentity.paletteSize).contains(AgentIdentity.colorIndex("탐색")))
    }

    @Test func pluginBadge() {
        #expect(AgentIdentity.pluginBadge("oh-my-claudecode:executor") == "OMC")
        #expect(AgentIdentity.pluginBadge("acme-tools:smoke") == "acme-tools")
        #expect(AgentIdentity.pluginBadge("a-very-long-plugin-name:x") == "a-very-long…")
        #expect(AgentIdentity.pluginBadge("executor") == nil)
        #expect(AgentIdentity.pluginBadge(":x") == nil)
    }

    @Test func aFailureSpeaksLouderThanARunningAgent() {
        let failed = AgentNode(id: "1", toolUseId: "1", status: .failed)
        let running = AgentNode(id: "2", toolUseId: "2", status: .running)
        let stopped = AgentNode(id: "3", toolUseId: "3", status: .stopped)
        #expect(AgentCardEmphasis.of(failed, awaitingPermission: false) == .failed)
        #expect(AgentCardEmphasis.of(running, awaitingPermission: true) == .waiting)
        #expect(AgentCardEmphasis.of(failed, awaitingPermission: true) == .failed)
        #expect(AgentCardEmphasis.failed.border.opacity > AgentCardEmphasis.live.border.opacity)
        #expect(AgentCardEmphasis.failed.border.width > AgentCardEmphasis.live.border.width)
        #expect(AgentCardEmphasis.of(stopped, awaitingPermission: false).border.opacity < AgentCardEmphasis.done.border.opacity)
    }

    @Test func parallelAgentsBecomeRowsFromThree() {
        #expect(!AgentPanelLayout.compact(batch: 2))
        #expect(AgentPanelLayout.compact(batch: 3))
        var live = AgentNode(id: "1", toolUseId: "1", description: "TenantService 리팩터링", status: .running)
        #expect(AgentPanelLayout.rowDetail(live, nowMs: 0) == nil)   // the first line has the description
        live.lastTool = "Read"
        #expect(AgentPanelLayout.rowDetail(live, nowMs: 0) == "Read")
        var failed = AgentNode(id: "2", toolUseId: "2", description: "d", status: .failed)
        failed.error = "API Error: 529"
        #expect(AgentPanelLayout.rowDetail(failed, nowMs: 0) == "API Error: 529")
        var done = AgentNode(id: "3", toolUseId: "3", description: "d", status: .completed)
        #expect(AgentPanelLayout.rowDetail(done, nowMs: 0) == nil)
        done.summary = "요약"
        done.reportPreview = "\n## TenantContext 사용처 14군데\n- api 9"
        #expect(AgentPanelLayout.rowDetail(done, nowMs: 0) == "TenantContext 사용처 14군데")
    }
}
