import Foundation

// MARK: wave4c w4c-commit
// docs/PROTOCOL.md §41.1 on the wire (TypeScript: the §41.1 block of engine/src/protocol.ts): the team's commit format
// (`commit_format`), the PR sheet's draft (`pr_draft`), `pr_create`'s metadata and a compacted turn (`usage.compacted`).
// Every field is read leniently: an engine before §41 refuses the commands `unknown_command` (the screens then show what
// they showed before) and never sends `compacted`. A reply never fails to decode — a request waiting for it would wait forever.

/// Reply to `commit_format`: the format the recent subjects follow and the branch's issue number.
public struct CommitFormatReply: Sendable, Equatable {
    public var id: String?
    /// As a commit template (`#acme/{issue}/{title} - {summary}`); nil when the subjects follow no common format.
    public var learned: String?
    public var examples: [String]
    /// What `{issue}` renders on `branch` ("" without one).
    public var issue: String
    public var branch: String?
    /// The project's template, else `learned`, with `{issue}` / `{branch}` filled in; nil when neither.
    public var effective: String?
    /// "settings" / "learned" / nil.
    public var source: String?

    public init(id: String? = nil, learned: String? = nil, examples: [String] = [], issue: String = "", branch: String? = nil,
                effective: String? = nil, source: String? = nil) {
        self.id = id
        self.learned = learned
        self.examples = examples
        self.issue = issue
        self.branch = branch
        self.effective = effective
        self.source = source
    }
}

extension CommitFormatReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, learned, examples, issue, branch, effective, source }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), learned: lenientValue(String.self, c, .learned),
                  examples: lenientElements(String.self, c, .examples), issue: lenientValue(String.self, c, .issue) ?? "",
                  branch: lenientValue(String.self, c, .branch), effective: lenientValue(String.self, c, .effective),
                  source: lenientValue(String.self, c, .source))
    }
}

/// Whether `gh pr create` can run (`pr_draft.gh`); an unknown value reads as `.ok` (the create then says what failed).
public enum GHReadiness: String, Sendable, Equatable {
    case ok
    case notFound = "not_found"
    case notLoggedIn = "not_logged_in"
}

/// Reply to `pr_draft`: the PR sheet's title / body from the branch's commits, and what the create would do first.
public struct PRDraftReply: Sendable, Equatable {
    public var id: String?
    public var title: String
    public var body: String
    /// Oldest first.
    public var commits: [String]
    public var baseRef: String?
    /// False: the create pushes the branch first (only when the user creates the PR).
    public var hasUpstream: Bool
    public var gh: GHReadiness
    public var host: String?

    public init(id: String? = nil, title: String = "", body: String = "", commits: [String] = [], baseRef: String? = nil,
                hasUpstream: Bool = true, gh: GHReadiness = .ok, host: String? = nil) {
        self.id = id
        self.title = title
        self.body = body
        self.commits = commits
        self.baseRef = baseRef
        self.hasUpstream = hasUpstream
        self.gh = gh
        self.host = host
    }
}

extension PRDraftReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, title, body, commits, baseRef, hasUpstream, gh, host }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), title: lenientValue(String.self, c, .title) ?? "",
                  body: lenientValue(String.self, c, .body) ?? "", commits: lenientElements(String.self, c, .commits),
                  baseRef: lenientValue(String.self, c, .baseRef), hasUpstream: lenientValue(Bool.self, c, .hasUpstream) ?? true,
                  gh: lenientValue(String.self, c, .gh).flatMap(GHReadiness.init(rawValue:)) ?? .ok,
                  host: lenientValue(String.self, c, .host))
    }
}

/// §51: reply to `pr_ai_draft` — Claude's title ("" when the answer had none) and description for the PR sheet.
public struct PRAiDraftReply: Sendable, Equatable {
    public var id: String?
    public var title: String
    public var body: String

    public init(id: String? = nil, title: String = "", body: String = "") {
        self.id = id
        self.title = title
        self.body = body
    }
}

extension PRAiDraftReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, title, body }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), title: lenientValue(String.self, c, .title) ?? "",
                  body: lenientValue(String.self, c, .body) ?? "")
    }
}

/// `pr_create`'s metadata: one `gh pr create` flag per value (`@me` = the logged-in user); empty lists are not sent.
public struct PRCreateMeta: Sendable, Equatable {
    public var assignees: [String]
    public var labels: [String]
    public var reviewers: [String]
    public var projects: [String]

    public init(assignees: [String] = [], labels: [String] = [], reviewers: [String] = [], projects: [String] = []) {
        self.assignees = assignees
        self.labels = labels
        self.reviewers = reviewers
        self.projects = projects
    }
}

/// `turn_end.usage.compacted`: the conversation was compacted in this turn (`/compact` or the CLI's auto-compaction).
public struct TurnCompaction: Codable, Sendable, Equatable {
    /// "manual" or "auto".
    public var trigger: String
    public var preTokens: Int?

    public init(trigger: String, preTokens: Int? = nil) {
        self.trigger = trigger
        self.preTokens = preTokens
    }

    private enum CodingKeys: String, CodingKey { case trigger, preTokens }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(trigger: lenientValue(String.self, c, .trigger) ?? "manual", preTokens: lenientValue(Int.self, c, .preTokens))
    }
}

extension EngineCommand {
    private enum TeamFormatKeys: String, CodingKey { case base, title, body, draft, assignees, labels, reviewers, projects }

    /// The §41.1 commands' fields (`type` is written by the caller).
    func encodeTeamFormatFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: TeamFormatKeys.self)
        switch self {
        case let .prDraft(base):
            try c.encode(base, forKey: .base)
        case let .prAiDraft(base, title, body):   // §51
            try c.encode(base, forKey: .base)
            if !title.isEmpty { try c.encode(title, forKey: .title) }
            if !body.isEmpty { try c.encode(body, forKey: .body) }
        case let .prCreateMeta(base, title, body, draft, meta):
            try c.encode(base, forKey: .base)
            try c.encodeIfPresent(title, forKey: .title)
            try c.encodeIfPresent(body, forKey: .body)
            try c.encodeIfPresent(draft, forKey: .draft)
            if !meta.assignees.isEmpty { try c.encode(meta.assignees, forKey: .assignees) }
            if !meta.labels.isEmpty { try c.encode(meta.labels, forKey: .labels) }
            if !meta.reviewers.isEmpty { try c.encode(meta.reviewers, forKey: .reviewers) }
            if !meta.projects.isEmpty { try c.encode(meta.projects, forKey: .projects) }
        default:
            break
        }
    }
}
