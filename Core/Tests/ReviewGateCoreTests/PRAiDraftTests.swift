import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §51 on the Swift side: "Fill with Claude" in the PR sheet — `pr_ai_draft` on the wire, its reply, and
/// a refusal in the user's words.
@MainActor
@Suite struct PRAiDraftTests {
    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(id: nil, command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "PRAiDraftTests.\(UUID().uuidString)")!)
    }

    @Test func theCommandCarriesTheSheetsDraftOnlyWhenThere() throws {
        let full = try json(.prAiDraft(base: "develop", title: "#acme/42: Fix the cart", body: "- #acme/42: Fix the cart"))
        #expect(full["type"] as? String == "pr_ai_draft")
        #expect(full["base"] as? String == "develop")
        #expect(full["title"] as? String == "#acme/42: Fix the cart")
        #expect(full["body"] as? String == "- #acme/42: Fix the cart")
        let bare = try json(.prAiDraft(base: "main", title: "", body: ""))
        #expect(bare["title"] == nil && bare["body"] == nil)
    }

    @Test func theReplyDecodesLeniently() throws {
        guard case let .prAiDraft(reply) = try NDJSON.decode(EngineEvent.self, from: #"{"type":"pr_ai_draft","id":"r1","title":"Fix","body":"Summary"}"#) else {
            Issue.record("not prAiDraft"); return
        }
        #expect(reply == PRAiDraftReply(id: "r1", title: "Fix", body: "Summary"))
        guard case let .prAiDraft(odd) = try NDJSON.decode(EngineEvent.self, from: #"{"type":"pr_ai_draft","title":7}"#) else {
            Issue.record("not prAiDraft"); return
        }
        #expect(odd == PRAiDraftReply())
    }

    @Test func writePRDraftReturnsTheDraftOrWhyNot() async {
        let store = makeStore()
        var sent: [EngineCommand] = []
        store.replySink = { command in
            sent.append(command)
            return .prAiDraft(PRAiDraftReply(title: "Fix the cart", body: "## Summary"))
        }
        #expect(await store.writePRDraft(base: "main", title: "t", body: "b") == .success(PRAiDraftReply(title: "Fix the cart", body: "## Summary")))
        if case let .prAiDraft(base, title, body) = sent.first { #expect(base == "main" && title == "t" && body == "b") } else { Issue.record("not prAiDraft") }
        store.replySink = { _ in throw EngineClientError.refused("pr_ai_draft_failed:no commits since origin/main", code: "pr_ai_draft_failed") }
        guard case let .failure(failure) = await store.writePRDraft(base: "main", title: "", body: "") else { Issue.record("not a failure"); return }
        #expect(failure.text.contains("no commits since origin/main"))
        guard case .failure = await store.writePRDraft(base: "", title: "", body: "") else { Issue.record("a blank base went out"); return }
        #expect(sent.count == 1)
    }
}
