import Foundation
import Testing
@testable import ReviewGateCore

/// §60 on the Mac: the Conversation as one time-ordered thread (description, comments, reviews) and every inline
/// comment of the PR grouped by file and line ("Code comments").
@Suite struct PRTimelineTests {
    private func at(_ seconds: TimeInterval) -> Date { Date(timeIntervalSince1970: 1_700_000_000 + seconds) }

    private func detail() -> PRDetail {
        PRDetail(number: 7, title: "Add search", body: "Adds **search**.", author: "alice", state: "OPEN",
                 url: "https://github.com/acme/app/pull/7", headRefName: "feature/search", baseRefName: "main",
                 headRefOid: "abc", reviewDecision: "", additions: 1, deletions: 0, changedFiles: 1)
    }

    private func issueComment(_ id: Int, _ seconds: TimeInterval, author: String = "bob") -> PRIssueComment {
        PRIssueComment(id: id, author: author, body: "comment \(id)", createdAt: at(seconds), updatedAt: at(seconds),
                       url: "https://github.com/acme/app/pull/7#issuecomment-\(id)")
    }

    private func review(_ id: Int, _ state: String, _ seconds: TimeInterval?, body: String = "") -> PRReview {
        PRReview(id: id, author: "carol", state: state, body: body, submittedAt: seconds.map(at))
    }

    private func inline(_ id: Int, _ path: String, line: Int?, side: String? = "RIGHT", _ seconds: TimeInterval) -> PRComment {
        PRComment(id: id, path: path, line: line, side: side, startLine: nil, body: "inline \(id)", author: "dave",
                  createdAt: at(seconds), inReplyTo: nil, diffHunk: "@@ -1 +1 @@")
    }

    // MARK: The thread

    @Test func theThreadIsTheDescriptionThenCommentsAndReviewsByTime() {
        let items = PRTimeline.items(
            selected: detail(),
            conversation: [issueComment(1, 10), issueComment(2, 40)],
            reviews: [review(100, "APPROVED", 30), review(101, "CHANGES_REQUESTED", 5, body: "Please fix"),
                      review(102, "PENDING", nil), review(103, "COMMENTED", 20), review(104, "COMMENTED", 50, body: "Nit")])
        #expect(items.map(\.id) == ["description", "review-101", "comment-1", "review-100", "comment-2", "review-104"])
        if case let .description(author, body) = items.first { #expect(author == "alice" && body == "Adds **search**.") }
        else { Issue.record("the description is not first") }
    }

    @Test func equalTimesKeepCommentsBeforeReviewsAndNoPRMeansNoDescription() {
        let items = PRTimeline.items(selected: nil, conversation: [issueComment(1, 10)], reviews: [review(100, "APPROVED", 10)])
        #expect(items.map(\.id) == ["comment-1", "review-100"])
        #expect(PRTimeline.items(selected: detail(), conversation: [], reviews: []).map(\.id) == ["description"])
    }

    // MARK: Code comments

    @Test func inlineCommentsGroupByFileInTheFilesOrderThenByLine() {
        let groups = PRCodeComments.group([
            inline(1, "b.swift", line: 30, 10),
            inline(2, "a.swift", line: 12, 20),
            inline(3, "a.swift", line: 4, side: "LEFT", 30),
            inline(4, "a.swift", line: 12, 5),
            inline(5, "a.swift", line: nil, 1),
            inline(6, "z-not-in-files.swift", line: 1, 1),
            inline(7, "a.swift", line: 4, side: nil, 2),
        ], fileOrder: ["b.swift", "a.swift"])
        #expect(groups.map(\.path) == ["b.swift", "a.swift", "z-not-in-files.swift"])
        let a = groups[1]
        #expect(a.count == 5)
        #expect(a.lines.map(\.line) == [4, 4, 12, nil])
        #expect(a.lines.map(\.side) == ["LEFT", "RIGHT", "RIGHT", ""])   // a side GitHub left out reads as RIGHT
        #expect(a.lines[2].comments.map(\.id) == [4, 2])   // oldest first
        #expect(Set(a.lines.map(\.id)).count == a.lines.count)
    }
}
