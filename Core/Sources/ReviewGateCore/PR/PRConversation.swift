import Foundation

/// §60: one entry of the PR's Conversation thread — the description, a general comment or a submitted review.
public enum PRTimelineItem: Identifiable, Hashable, Sendable {
    /// The PR's description (`PRDetail.body` by `PRDetail.author`); always first.
    case description(author: String, body: String)
    case comment(PRIssueComment)
    case review(PRReview)

    public var id: String {
        switch self {
        case .description: "description"
        case let .comment(c): "comment-\(c.id)"
        case let .review(r): "review-\(r.id)"
        }
    }

    /// When it was written; nil for the description (the wire has no creation date for the PR).
    public var date: Date? {
        switch self {
        case .description: nil
        case let .comment(c): c.createdAt
        case let .review(r): r.submittedAt
        }
    }
}

/// §60: the Conversation as one time-ordered thread.
public enum PRTimeline {
    /// The description first, then the conversation comments (`createdAt`) and the reviews (`submittedAt`) merged by time
    /// (equal times keep comments before reviews, each in the engine's order). A PENDING review (not submitted) stays out,
    /// and so does a COMMENTED review with no body: GitHub makes one for every batch of inline comments, which are listed
    /// under "Code comments" already. An approval or a change request with no body still shows its state.
    public static func items(selected: PRDetail?, conversation: [PRIssueComment], reviews: [PRReview]) -> [PRTimelineItem] {
        var dated: [(date: Date, order: Int, item: PRTimelineItem)] = []
        for comment in conversation { dated.append((comment.createdAt, dated.count, .comment(comment))) }
        for review in reviews {
            guard review.state != "PENDING", let at = review.submittedAt else { continue }
            if review.state == "COMMENTED", review.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            dated.append((at, dated.count, .review(review)))
        }
        dated.sort { $0.date != $1.date ? $0.date < $1.date : $0.order < $1.order }
        var items: [PRTimelineItem] = []
        if let selected { items.append(.description(author: selected.author, body: selected.body)) }
        items.append(contentsOf: dated.map(\.item))
        return items
    }
}

/// §60 (Mac): the inline review comments on one line of one file (or a file's outdated ones), oldest first.
public struct PRCodeCommentLine: Identifiable, Hashable, Sendable {
    public let path: String
    /// LEFT / RIGHT (RIGHT when GitHub sent none, as the diff pane reads it); "" for the outdated ones.
    public let side: String
    /// nil: the file's outdated comments (their line is no longer in the diff).
    public let line: Int?
    public let comments: [PRComment]

    public var id: String { "\(path)|\(side)|\(line.map(String.init) ?? "outdated")" }
}

/// §60 (Mac): one file's inline review comments, by line.
public struct PRCodeCommentFile: Identifiable, Hashable, Sendable {
    public let path: String
    public let lines: [PRCodeCommentLine]

    public var id: String { path }
    public var count: Int { lines.reduce(0) { $0 + $1.comments.count } }
}

/// §60 (Mac): every inline review comment of the PR in one list, grouped by file and line.
public enum PRCodeComments {
    /// Files in `fileOrder` (the PR's file list), any other path after them by name; in a file the lines by number
    /// (LEFT before RIGHT on the same number) and the outdated comments last; each line's comments oldest first.
    public static func group(_ comments: [PRComment], fileOrder: [String]) -> [PRCodeCommentFile] {
        struct Key: Hashable { let side: String; let line: Int? }
        var byPath: [String: [Key: [PRComment]]] = [:]
        for comment in comments {
            let key = comment.line == nil ? Key(side: "", line: nil) : Key(side: comment.side ?? "RIGHT", line: comment.line)
            byPath[comment.path, default: [:]][key, default: []].append(comment)
        }
        let rank = Dictionary(fileOrder.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        let paths = byPath.keys.sorted { a, b in
            switch (rank[a], rank[b]) {
            case let (x?, y?): x < y
            case (_?, nil): true
            case (nil, _?): false
            case (nil, nil): a < b
            }
        }
        return paths.map { path in
            let keys = byPath[path]!.keys.sorted { a, b in
                switch (a.line, b.line) {
                case let (x?, y?): x != y ? x < y : a.side < b.side
                case (_?, nil): true
                case (nil, _): false
                }
            }
            let lines = keys.map { key in
                PRCodeCommentLine(path: path, side: key.line == nil ? "" : key.side, line: key.line,
                                  comments: byPath[path]![key]!.sorted { $0.createdAt != $1.createdAt ? $0.createdAt < $1.createdAt : $0.id < $1.id })
            }
            return PRCodeCommentFile(path: path, lines: lines)
        }
    }
}
