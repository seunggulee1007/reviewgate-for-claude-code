import Foundation
import Testing
@testable import ReviewGateCore
#if canImport(AppKit)
import AppKit
#endif

/// wave5 w5-board: docs/PROTOCOL.md §43.1 — the agent board's avatars, tool icons and friendly MCP names (the same fixture
/// Electron's agentAvatar.test.ts reads), the mood of an agent, the summary line and what the board remembers.
@Suite struct AgentBoardTests {
    private static let repo: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url
    }()

    private func fixture() throws -> [String: Any] {
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("engine/test/fixtures/agentAvatars.json"))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func hex(_ v: UInt32) -> String { String(format: "#%06X", v) }

    @Test func tonesMatchTheFixture() throws {
        let tones = try #require(try fixture()["tones"] as? [String: [String: String]])
        #expect(Set(tones.keys) == Set(AgentAvatarTone.allCases.map(\.rawValue)))
        for tone in AgentAvatarTone.allCases {
            let want = try #require(tones[tone.rawValue])
            #expect(hex(tone.hex.light) == want["light"], "\(tone)")
            #expect(hex(tone.hex.dark) == want["dark"], "\(tone)")
        }
    }

    @Test func avatarsMatchTheFixture() throws {
        let cases = try #require(try fixture()["types"] as? [[String: Any]])
        #expect(cases.count >= 20)
        for c in cases {
            let type = try #require(c["type"] as? String)
            let got = AgentAvatar.of(type: type)
            #expect(got.icon.rawValue == c["icon"] as? String, "\(type)")
            #expect(got.tone.rawValue == c["tone"] as? String, "\(type)")
            #expect(got.name == c["name"] as? String, "\(type)")
            #expect(got.badge == c["badge"] as? String, "\(type)")
        }
        let main = try #require(try fixture()["main"] as? [String: String])
        #expect(AgentAvatar.main.icon.rawValue == main["icon"])
        #expect(AgentAvatar.main.tone.rawValue == main["tone"])
    }

    @Test func toolsMatchTheFixture() throws {
        let cases = try #require(try fixture()["tools"] as? [[String: Any]])
        for c in cases {
            let tool = try #require(c["tool"] as? String)
            let detail = c["detail"] as? String
            #expect(AgentToolIcon.of(tool: tool).rawValue == c["icon"] as? String, "\(tool)")
            if McpServerKind.of(ToolLabel.of(tool).server ?? "") != nil {
                // The friendly names are the board's own words in both languages.
                #expect(AgentToolText.text(tool: tool, detail: detail, language: "ko") == c["ko"] as? String, "\(tool)")
                #expect(AgentToolText.text(tool: tool, detail: detail, language: "en") == c["en"] as? String, "\(tool)")
            } else {
                // Everything else reads as the §39.3 title (localized by the catalogs).
                #expect(AgentToolText.text(tool: tool, detail: detail, language: "ko") == AgentGlance.toolTitle(tool, detail: detail), "\(tool)")
            }
        }
    }

    #if canImport(AppKit)
    @Test func everySymbolExists() {
        for icon in AgentAvatarIcon.allCases {
            guard let name = icon.symbol else { continue }
            #expect(NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil, "\(name)")
        }
        for icon in AgentToolIcon.allCases {
            #expect(NSImage(systemSymbolName: icon.symbol, accessibilityDescription: nil) != nil, "\(icon.symbol)")
        }
    }
    #endif

    @Test func moods() {
        var a = AgentNode(id: "1", toolUseId: "1", status: .running)
        #expect(AgentMood.of(a, awaitingPermission: false) == .working)
        #expect(AgentMood.of(a, awaitingPermission: true) == .waiting)
        a.retry = AgentRetry(attempt: 2, max: 10, at: 1)
        #expect(AgentMood.of(a, awaitingPermission: false) == .retrying)
        #expect(AgentMood.of(a, awaitingPermission: true) == .waiting)
        a.status = .paused
        #expect(AgentMood.of(a, awaitingPermission: false) == .idle)
        a.status = .completed
        #expect(AgentMood.of(a, awaitingPermission: true) == .done)
        a.status = .failed
        #expect(AgentMood.of(a, awaitingPermission: false) == .failed)
        a.status = .stopped
        #expect(AgentMood.of(a, awaitingPermission: false) == .stopped)
        #expect(AgentMood.main(running: true, awaitingPermission: false) == .working)
        #expect(AgentMood.main(running: true, awaitingPermission: true) == .waiting)
        #expect(AgentMood.main(running: false, awaitingPermission: false) == .idle)
        #expect(AgentMood.working.moves && AgentMood.waiting.moves && AgentMood.retrying.moves)
        #expect(!AgentMood.done.moves && !AgentMood.idle.moves && !AgentMood.failed.moves)
    }

    @Test func summaryCountsWhoIsDoingWhatAndWhoCameToday() {
        let calendar = Calendar(identifier: .gregorian)
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let today = now.timeIntervalSince1970 * 1000 - 60_000
        let yesterday = calendar.startOfDay(for: now).timeIntervalSince1970 * 1000 - 1
        var retrying = AgentNode(id: "r", toolUseId: "r", status: .running, startedAt: today)
        retrying.retry = AgentRetry(attempt: 1, max: 10, at: today)
        let agents = [
            AgentNode(id: "a", toolUseId: "a", status: .running, startedAt: today),
            AgentNode(id: "b", toolUseId: "b", status: .running, startedAt: today),
            AgentNode(id: "c", toolUseId: "c", status: .running, startedAt: today),
            retrying,
            AgentNode(id: "d", toolUseId: "d", status: .completed, startedAt: today),
        ]
        let history = [
            AgentNode(id: "h1", toolUseId: "h1", status: .completed, startedAt: today),
            AgentNode(id: "a", toolUseId: "a", status: .completed, startedAt: today),   // continued: counted once
            AgentNode(id: "h2", toolUseId: "h2", status: .completed, startedAt: yesterday),
        ]
        let s = AgentBoardSummary.of(agents: agents, history: history, awaiting: { $0.toolUseId == "c" }, mainWaiting: true,
                                     now: now, calendar: calendar)
        #expect(s == AgentBoardSummary(working: 2, waiting: 2, retrying: 1, today: 6))
        #expect(s.parts.count == 4)
        #expect(AgentBoardSummary().parts.count == 1)                  // all quiet
        #expect(AgentBoardSummary(today: 3).parts.count == 2)          // resting · visited today
    }

    @Test func boardPrefsRememberTabAndOpenPerProject() throws {
        let suite = "AgentBoardTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(BoardPrefs.tab(project: "/a", defaults: defaults) == .agents)
        BoardPrefs.setTab(.graph, project: "/a", defaults: defaults)
        #expect(BoardPrefs.tab(project: "/a", defaults: defaults) == .graph)
        #expect(BoardPrefs.tab(project: "/b", defaults: defaults) == .agents)
        defaults.set("nonsense", forKey: "board.tab./b")
        #expect(BoardPrefs.tab(project: "/b", defaults: defaults) == .agents)
        #expect(!BoardPrefs.wasOpen(project: "/a", defaults: defaults))
        BoardPrefs.setOpen(true, project: "/a", defaults: defaults)
        #expect(BoardPrefs.wasOpen(project: "/a", defaults: defaults))
        BoardPrefs.setOpen(false, project: "/a", defaults: defaults)
        #expect(!BoardPrefs.wasOpen(project: "/a", defaults: defaults))
        #expect(BoardPrefs.frameName(project: "/a") == BoardPrefs.frameName(project: "/a"))
        #expect(BoardPrefs.frameName(project: "/a") != BoardPrefs.frameName(project: "/b"))
        #expect(BoardTab.allCases.map(\.rawValue) == ["agents", "brain", "graph"])
    }
}
