import Foundation
import Testing
@testable import ReviewGateCore

/// What is typed in the PR tab before it is sent — the review sheet's summary and event, an inline comment or reply —
/// outlives the views (Cancel, another file, another tab) and goes when another PR opens.
@Suite @MainActor struct PRStoreDraftsTests {
    private func summary(_ number: Int) -> PRSummary {
        PRSummary(number: number, title: "PR \(number)", repo: "org/app", host: "ghe.example", author: "me",
                  updatedAt: Date(timeIntervalSince1970: 0), url: "https://ghe.example/org/app/pull/\(number)", isDraft: false)
    }

    private func state(_ selected: PRSummary?, loading: Bool = false) -> PRState {
        var s = PRState.empty(host: "ghe.example")
        s.selectedSummary = selected
        s.isLoading = loading
        return s
    }

    @Test func draftsStayWithTheOpenPRAndGoWithAnother() {
        let store = PRStore(defaults: UserDefaults(suiteName: "PRStoreDraftsTests.\(UUID().uuidString)")!)
        store.apply(state(summary(1)))
        store.reviewSummaryDraft = "Looks good, two nits"
        store.reviewEventDraft = .approve
        let key = PRStore.commentDraftKey(path: "src/a.ts", side: "RIGHT", line: 12)
        store.commentDrafts[key] = "rename this"
        #expect(key != PRStore.commentDraftKey(path: "src/a.ts", side: "RIGHT", line: 12, replyTo: 7))
        #expect(key != PRStore.commentDraftKey(path: "src/a.ts", side: "LEFT", line: 12))

        // The same PR again (a reload, the detail arriving): nothing typed is lost.
        store.apply(state(summary(1), loading: true))
        #expect(store.reviewSummaryDraft == "Looks good, two nits" && store.reviewEventDraft == .approve)
        #expect(store.commentDrafts[key] == "rename this")

        // Another PR: the old one's text goes.
        store.apply(state(summary(2)))
        #expect(store.reviewSummaryDraft.isEmpty && store.reviewEventDraft == .comment && store.commentDrafts.isEmpty)
    }
}
