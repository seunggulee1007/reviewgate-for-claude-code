import Foundation
import Testing
@testable import ReviewGateCore

/// §60: the PR's conversation on the Mac — `state.pr.conversation` / `isCommenting` (with their defaults for an older
/// engine), `pr_comment` and what the composer is told after it.
@Suite @MainActor struct PRConversationTests {
    private func at(_ seconds: TimeInterval) -> Date { Date(timeIntervalSince1970: 1_700_000_000 + seconds) }

    // MARK: Wire

    @Test func decodesTheConversationAndTheCommentingFlag() throws {
        let json = #"""
        {"host":"github.com","mine":[],"reviewRequested":[],"selectedSummary":null,"selected":null,"files":[],"comments":[],
         "reviews":[],"draftComments":[],"accounts":[],"isLoading":false,"isSubmitting":false,"errorText":null,
         "lastSubmitResult":null,"lastCreatedPR":null,"isCommenting":true,
         "conversation":[{"id":11,"author":"bob","body":"LGTM","createdAt":"2026-11-20T10:00:00Z","updatedAt":"2026-11-20T10:05:00Z",
                          "url":"https://github.com/acme/app/pull/7#issuecomment-11","authorAssociation":"MEMBER"},
                         {"id":12,"author":"ghost","body":"","createdAt":"2026-11-20T11:00:00Z","updatedAt":null,
                          "url":"https://github.com/acme/app/pull/7#issuecomment-12"}]}
        """#
        let state = try NDJSON.decode(PRState.self, from: json)
        let conversation = try #require(state.conversation)
        #expect(conversation.map(\.id) == [11, 12] && state.isCommenting == true)
        #expect(conversation[0].isEdited && conversation[0].authorAssociation == "MEMBER")
        #expect(!conversation[1].isEdited && conversation[1].updatedAt == nil && conversation[1].authorAssociation == nil)

        let store = PRStore(defaults: UserDefaults(suiteName: "PRConversationTests.\(UUID().uuidString)")!)
        store.apply(state)
        #expect(store.conversation.count == 2 && store.isCommenting)
    }

    @Test func anEngineBeforeSection60MeansNoConversationAndNotCommenting() throws {
        let json = #"""
        {"host":"github.com","mine":[],"reviewRequested":[],"selectedSummary":null,"selected":null,"files":[],"comments":[],
         "reviews":[],"draftComments":[],"accounts":[],"isLoading":false,"isSubmitting":false,"errorText":null,"lastSubmitResult":null}
        """#
        let state = try NDJSON.decode(PRState.self, from: json)
        #expect(state.conversation == nil && state.isCommenting == nil)
        let store = PRStore(defaults: UserDefaults(suiteName: "PRConversationTests.\(UUID().uuidString)")!)
        store.apply(state)
        #expect(store.conversation.isEmpty && !store.isCommenting)
    }

    @Test func encodesPrComment() throws {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(id: "c1", command: .prComment(body: "  Thanks!\n")))
        let cmd = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(cmd.keys) == ["type", "id", "body"])
        #expect(cmd["type"] as? String == "pr_comment" && cmd["body"] as? String == "  Thanks!\n")   // as typed
    }

    // MARK: Posting

    @Test func aPostedCommentAnswersNilAndARefusalAnswersItsWords() async {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "PRConversationTests.\(UUID().uuidString)")!)
        var sent: [EngineCommand] = []
        app.requestSink = { sent.append($0) }
        #expect(await app.pr.comment("Thanks!") == nil)
        if case let .prComment(body) = sent.first { #expect(body == "Thanks!") } else { Issue.record("not pr_comment") }

        app.requestSink = { _ in throw EngineClientError.refused("pr_comment_failed:gh: not logged in", code: "pr_comment_failed") }
        let failed = await app.pr.comment("Thanks!")
        #expect(failed == EngineMessages.refusal(code: "pr_comment_failed", error: "pr_comment_failed:gh: not logged in"))
        #expect(failed?.contains("gh: not logged in") == true)

        app.requestSink = { _ in throw EngineClientError.refused("empty_body", code: "empty_body") }
        #expect(await app.pr.comment(" ") == EngineMessages.refusal(error: "empty_body"))
        #expect(EngineMessages.refusal(error: "no_pr_selected") != "no_pr_selected")
    }

    @Test func theDraftStaysWithThePRAndGoesWithAnother() {
        let store = PRStore(defaults: UserDefaults(suiteName: "PRConversationTests.\(UUID().uuidString)")!)
        func summary(_ n: Int) -> PRSummary {
            PRSummary(number: n, title: "PR", repo: "acme/app", host: "github.com", author: "alice", updatedAt: at(0),
                      url: "https://github.com/acme/app/pull/\(n)", isDraft: false)
        }
        var s = PRState.empty(host: "github.com")
        s.selectedSummary = summary(1)
        store.apply(s)
        store.conversationDraft = "half a thought"
        s.isLoading = true
        store.apply(s)
        #expect(store.conversationDraft == "half a thought")
        s.selectedSummary = summary(2)
        store.apply(s)
        #expect(store.conversationDraft.isEmpty)
    }
}
