import Foundation

/// One row of the PR list (from `search/issues`).
public struct PRSummary: Codable, Sendable, Identifiable, Hashable {
    public var number: Int
    public var title: String
    /// `owner/name`
    public var repo: String
    public var host: String
    public var author: String
    public var updatedAt: Date
    public var url: String
    public var isDraft: Bool

    public var id: String { "\(host)/\(repo)#\(number)" }

    public init(number: Int, title: String, repo: String, host: String, author: String,
                updatedAt: Date, url: String, isDraft: Bool) {
        self.number = number
        self.title = title
        self.repo = repo
        self.host = host
        self.author = author
        self.updatedAt = updatedAt
        self.url = url
        self.isDraft = isDraft
    }
}

/// `gh pr view --json …`
public struct PRDetail: Codable, Sendable, Identifiable, Hashable {
    public var number: Int
    public var title: String
    public var body: String
    public var author: String
    /// OPEN / CLOSED / MERGED
    public var state: String
    public var url: String
    public var headRefName: String
    public var baseRefName: String
    public var headRefOid: String
    /// APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / "" (none)
    public var reviewDecision: String
    public var additions: Int
    public var deletions: Int
    public var changedFiles: Int

    public var id: Int { number }

    public init(number: Int, title: String, body: String, author: String, state: String, url: String,
                headRefName: String, baseRefName: String, headRefOid: String, reviewDecision: String,
                additions: Int, deletions: Int, changedFiles: Int) {
        self.number = number
        self.title = title
        self.body = body
        self.author = author
        self.state = state
        self.url = url
        self.headRefName = headRefName
        self.baseRefName = baseRefName
        self.headRefOid = headRefOid
        self.reviewDecision = reviewDecision
        self.additions = additions
        self.deletions = deletions
        self.changedFiles = changedFiles
    }
}

/// One entry of `repos/O/R/pulls/N/files`.
public struct PRFile: Codable, Sendable, Identifiable, Hashable {
    public var filename: String
    public var previousFilename: String?
    /// added / removed / modified / renamed / copied / changed / unchanged
    public var status: String
    public var additions: Int
    public var deletions: Int
    /// Headerless unified patch; nil for binary or very large files.
    public var patch: String?

    public var id: String { filename }

    public init(filename: String, previousFilename: String?, status: String, additions: Int, deletions: Int, patch: String?) {
        self.filename = filename
        self.previousFilename = previousFilename
        self.status = status
        self.additions = additions
        self.deletions = deletions
        self.patch = patch
    }
}

/// A review (inline) comment from `repos/O/R/pulls/N/comments`.
public struct PRComment: Codable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var path: String
    /// nil when the comment is outdated (its line no longer exists in the current diff).
    public var line: Int?
    /// LEFT / RIGHT
    public var side: String?
    public var startLine: Int?
    public var body: String
    public var author: String
    public var createdAt: Date
    public var inReplyTo: Int?
    public var diffHunk: String

    public init(id: Int, path: String, line: Int?, side: String?, startLine: Int?, body: String,
                author: String, createdAt: Date, inReplyTo: Int?, diffHunk: String) {
        self.id = id
        self.path = path
        self.line = line
        self.side = side
        self.startLine = startLine
        self.body = body
        self.author = author
        self.createdAt = createdAt
        self.inReplyTo = inReplyTo
        self.diffHunk = diffHunk
    }
}

/// One entry of `repos/O/R/pulls/N/reviews`.
public struct PRReview: Codable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var author: String
    /// APPROVED / CHANGES_REQUESTED / COMMENTED / PENDING / DISMISSED
    public var state: String
    public var body: String
    /// nil for PENDING reviews.
    public var submittedAt: Date?
    /// `html_url` of the review (nil when the API omitted it).
    public var url: String?

    public init(id: Int, author: String, state: String, body: String, submittedAt: Date?, url: String? = nil) {
        self.id = id
        self.author = author
        self.state = state
        self.body = body
        self.submittedAt = submittedAt
        self.url = url
    }
}

/// A not-yet-submitted inline comment, collected in the app and sent with `submitReview`.
/// `id` is engine-generated on the wire; the composer's local default is discarded by `pr_add_draft`.
public struct DraftComment: Codable, Sendable, Identifiable, Hashable {
    public var id: String
    public var path: String
    public var line: Int
    /// LEFT / RIGHT
    public var side: String
    public var startLine: Int?
    public var body: String

    public init(id: String = UUID().uuidString, path: String, line: Int, side: String, startLine: Int? = nil, body: String) {
        self.id = id
        self.path = path
        self.line = line
        self.side = side
        self.startLine = startLine
        self.body = body
    }
}

public enum ReviewEvent: String, Codable, Sendable, CaseIterable {
    case comment = "COMMENT"
    case approve = "APPROVE"
    case requestChanges = "REQUEST_CHANGES"
}

/// One `gh` host as reported by `gh auth status` (`state.pr.accounts`).
public struct GHAccount: Codable, Sendable, Identifiable, Hashable {
    public var id: String { host }
    public let host: String
    public let login: String?
    public let ok: Bool
    /// Human-readable status for that host (login/scopes on success, the error otherwise).
    public let detail: String

    public init(host: String, login: String?, ok: Bool, detail: String) {
        self.host = host
        self.login = login
        self.ok = ok
        self.detail = detail
    }
}

/// Outcome of a successful review submission (`state.pr.lastSubmitResult`); the UI shows it as a banner.
public struct SubmitResult: Codable, Sendable, Hashable {
    public let reviewURL: String
    public let inlineCount: Int
    public let event: ReviewEvent
    public let submittedAt: Date
    public init(reviewURL: String, inlineCount: Int, event: ReviewEvent, submittedAt: Date) {
        self.reviewURL = reviewURL
        self.inlineCount = inlineCount
        self.event = event
        self.submittedAt = submittedAt
    }
}
