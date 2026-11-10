import Foundation
import Testing
@testable import ReviewGateCore

// wave4c w4c-commit — docs/PROTOCOL.md §41.1: the team's format line, the PR sheet's metadata, a compacted turn's line and
// /clear in the palette (as on Electron, commitFormat.test.ts).

@Suite struct TeamFormatTests {
    private let reply = CommitFormatReply(learned: "PAY-{issue}: {title} - {summary}", examples: ["PAY-1400: 주문 마감 - 할인 계산 오류 수정"],
                                          issue: "1800", branch: "feature/PAY-1800-2", effective: "PAY-1800: {title} - {summary}", source: "learned")

    @Test func lineFollowsTheTemplateElseTheLearnedFormat() {
        let learned = TeamFormat.line(template: "", branch: "feature/PAY-1800-2", reply: reply)
        #expect(learned?.text == "PAY-1800: {title} - {summary}")
        #expect(learned?.learned == true)
        let own = TeamFormat.line(template: "[{issue}] {title}\nbody", branch: "feature/PAY-1800-2", reply: reply)
        #expect(own?.text == "[1800] {title}")
        #expect(own?.learned == false)
        #expect(TeamFormat.line(template: "", branch: "main", reply: nil) == nil)
        // A reply for another branch: the longest number of this one (the last run made `-17` the issue before §41.1).
        #expect(TeamFormat.issue(branch: "feature/PAY-1100-2", reply: reply) == "1100")
        #expect(CommitTemplate.issue(fromBranch: "feature/PAY-1800-2") == "1800")
        #expect(TeamFormat.suggestion(template: "", reply: reply) == "PAY-{issue}: {title} - {summary}")
        #expect(TeamFormat.suggestion(template: "PAY-{issue}: {title} - {summary}", reply: reply) == nil)
    }

    @Test func repliesDecodeLeniently() throws {
        let f = try JSONDecoder().decode(EngineEvent.self, from: Data(#"{"type":"commit_format","id":"c1","learned":null,"kind":null,"examples":["a",3],"issue":"12","branch":"b","effective":null,"source":null}"#.utf8))
        guard case let .commitFormat(format) = f else { Issue.record("not commit_format"); return }
        #expect(format.examples == ["a"])
        #expect(format.learned == nil)
        let d = try JSONDecoder().decode(EngineEvent.self, from: Data(#"{"type":"pr_draft","id":"p1","title":"T","body":"- a","commits":["a"],"baseRef":"origin/develop","hasUpstream":false,"gh":"not_logged_in","host":"ghe.example.com"}"#.utf8))
        guard case let .prDraft(draft) = d else { Issue.record("not pr_draft"); return }
        #expect(draft.gh == .notLoggedIn)
        #expect(draft.hasUpstream == false)
        #expect(TeamFormat.ghBlocker(draft.gh, host: draft.host)?.contains("ghe.example.com") == true)
        #expect(TeamFormat.ghBlocker(.ok, host: nil) == nil)
        let usage = try JSONDecoder().decode(Usage.self, from: Data(#"{"inputTokens":0,"outputTokens":0,"costUsd":0,"durationMs":1,"contextTokens":3704,"compacted":{"trigger":"manual","preTokens":16340}}"#.utf8))
        #expect(usage.compacted == TurnCompaction(trigger: "manual", preTokens: 16340))
        #expect(TeamFormat.compactedLine(usage.compacted!, postTokens: usage.contextTokens).contains("16.3k → 3.7k"))
    }

    @Test func prCreateCarriesTheMetadata() throws {
        let meta = PRMetaText(assignees: "@me", labels: "bug, , urgent,bug", reviewers: "", projects: "Acme 2026").meta
        #expect(meta == PRCreateMeta(assignees: ["@me"], labels: ["bug", "urgent"], reviewers: [], projects: ["Acme 2026"]))
        let data = try JSONEncoder().encode(EngineCommand.prCreateMeta(base: "develop", title: "T", body: nil, draft: nil, meta: meta))
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["type"] as? String == "pr_create")
        #expect(json["assignees"] as? [String] == ["@me"])
        #expect(json["reviewers"] == nil)
        let defaults = try #require(UserDefaults(suiteName: "TeamFormatTests-\(UUID().uuidString)"))
        #expect(AppSettings.prMeta(root: "/r", defaults: defaults) == .default)
        AppSettings.setPRMeta(PRMetaText(assignees: "@me", labels: "bug", reviewers: "", projects: ""), root: "/r", defaults: defaults)
        #expect(AppSettings.prMeta(root: "/r", defaults: defaults).labels == "bug")
        #expect(AppSettings.prMeta(root: "/other", defaults: defaults).labels == "")
    }

    @Test func clearReadsAsTheAppsNewChat() {
        var caps = SessionCapabilities(slashCommands: ["clear", "compact"], skills: [], plugins: [], mcpServers: [])
        caps.commands = [SlashCommandInfo(name: "clear", description: "Clear conversation history and free up context", aliases: ["reset"]),
                         SlashCommandInfo(name: "compact", description: "Clear conversation history but keep a summary")]
        let entries = SlashCommandCatalog.entries(caps)
        #expect(entries.first { $0.name == "clear" }?.description == TeamFormat.clearDescription)
        #expect(entries.first { $0.name == "compact" }?.description == "Clear conversation history but keep a summary")
    }
}
