import Foundation

// MARK: §53 commits in meaningful units
// docs/PROTOCOL.md §53 on the wire (TypeScript: the §53 block of engine/src/protocol.ts): the accepted changes as hunks
// (`commit_hunks`), Claude's proposal of the split (`commit_split_draft`) and the commits made in order (`commit_series` →
// `committed_series`; a failure after a commit carries what was made as `result.partial`). Every field is read leniently:
// an engine before §53 refuses the commands `unknown_command`, and a reply never fails to decode — a request waiting for it
// would wait forever.

/// One hunk of `git diff HEAD -- <path>`; `text` is the lines after the header (`+` / `-` / space, ≤ 300 of them).
public struct CommitHunk: Sendable, Equatable, Hashable {
    public var id: Int
    public var header: String
    public var added: Int
    public var deleted: Int
    public var text: String

    public init(id: Int, header: String = "", added: Int = 0, deleted: Int = 0, text: String = "") {
        self.id = id
        self.header = header
        self.added = added
        self.deleted = deleted
        self.text = text
    }
}

extension CommitHunk: Decodable {
    private enum CodingKeys: String, CodingKey { case id, header, added, deleted, text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = lenientValue(Int.self, c, .id) else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "a hunk without an id")
        }
        self.init(id: id, header: lenientValue(String.self, c, .header) ?? "", added: lenientValue(Int.self, c, .added) ?? 0,
                  deleted: lenientValue(Int.self, c, .deleted) ?? 0, text: lenientValue(String.self, c, .text) ?? "")
    }
}

/// An accepted file as `commit_hunks` sends it. `hunks` empty: the file can only go whole (added, deleted, binary, renamed,
/// a single hunk, …).
public struct CommitFile: Sendable, Equatable, Identifiable {
    public var path: String
    public var oldPath: String?
    public var status: ChangeStatus
    public var binary: Bool
    public var hunks: [CommitHunk]

    public var id: String { path }
    public var wholeOnly: Bool { hunks.isEmpty }

    public init(path: String, oldPath: String? = nil, status: ChangeStatus = .modified, binary: Bool = false, hunks: [CommitHunk] = []) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.binary = binary
        self.hunks = hunks
    }
}

extension CommitFile: Decodable {
    private enum CodingKeys: String, CodingKey { case path, oldPath, status, binary, hunks }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let path = lenientValue(String.self, c, .path), !path.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .path, in: c, debugDescription: "a file without a path")
        }
        self.init(path: path, oldPath: lenientValue(String.self, c, .oldPath),
                  status: lenientValue(String.self, c, .status).flatMap(ChangeStatus.init(rawValue:)) ?? .other,
                  binary: lenientValue(Bool.self, c, .binary) ?? false, hunks: lenientElements(CommitHunk.self, c, .hunks))
    }
}

/// One part of a planned commit: the file whole (`hunks` nil) or the hunks of `commit_hunks` it takes, by id.
public struct CommitPart: Sendable, Equatable, Hashable, Codable {
    public var path: String
    public var hunks: [Int]?

    public init(path: String, hunks: [Int]? = nil) {
        self.path = path
        self.hunks = hunks
    }

    private enum CodingKeys: String, CodingKey { case path, hunks }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let path = lenientValue(String.self, c, .path) else {
            throw DecodingError.dataCorruptedError(forKey: .path, in: c, debugDescription: "a part without a path")
        }
        self.init(path: path, hunks: lenientValue([Int].self, c, .hunks))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(path, forKey: .path)
        try c.encodeIfPresent(hunks, forKey: .hunks)   // no `hunks` = the whole file
    }
}

/// One planned commit; `why` (from `commit_split_draft`) says why its parts belong together and is never sent back.
public struct CommitPlan: Sendable, Equatable, Codable {
    public var message: String
    public var parts: [CommitPart]
    public var why: String?

    public init(message: String, parts: [CommitPart], why: String? = nil) {
        self.message = message
        self.parts = parts
        self.why = why
    }

    private enum CodingKeys: String, CodingKey { case message, parts, why }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let why = lenientValue(String.self, c, .why)?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(message: lenientValue(String.self, c, .message) ?? "", parts: lenientElements(CommitPart.self, c, .parts),
                  why: why?.isEmpty == false ? why : nil)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(message, forKey: .message)
        try c.encode(parts, forKey: .parts)
    }
}

/// A commit `commit_series` made (`message` with `settings.commitTrailer`; `files` the parts' paths).
public struct SeriesCommit: Sendable, Equatable, Identifiable {
    public var sha: String
    public var shortSha: String
    public var message: String
    public var files: [String]

    public var id: String { sha }
    /// The message's first line.
    public var subject: String { message.split(whereSeparator: \.isNewline).first.map(String.init) ?? "" }

    public init(sha: String, shortSha: String = "", message: String = "", files: [String] = []) {
        self.sha = sha
        self.shortSha = shortSha.isEmpty ? String(sha.prefix(7)) : shortSha
        self.message = message
        self.files = files
    }
}

extension SeriesCommit: Decodable {
    private enum CodingKeys: String, CodingKey { case sha, shortSha, message, files }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let sha = lenientValue(String.self, c, .sha), !sha.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .sha, in: c, debugDescription: "a commit without a sha")
        }
        self.init(sha: sha, shortSha: lenientValue(String.self, c, .shortSha) ?? "", message: lenientValue(String.self, c, .message) ?? "",
                  files: lenientElements(String.self, c, .files))
    }
}

/// Reply to `commit_hunks`: the accepted files as hunks of `git diff HEAD`, in file order.
public struct CommitHunksReply: Sendable, Equatable {
    public var id: String?
    public var files: [CommitFile]

    public init(id: String? = nil, files: [CommitFile] = []) {
        self.id = id
        self.files = files
    }
}

extension CommitHunksReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, files }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), files: lenientElements(CommitFile.self, c, .files))
    }
}

/// Reply to `commit_split_draft`: the proposed commits (only valid parts) and what none of them took. Nothing is committed.
public struct CommitSplitDraftReply: Sendable, Equatable {
    public var id: String?
    public var commits: [CommitPlan]
    public var unassigned: [CommitPart]

    public init(id: String? = nil, commits: [CommitPlan] = [], unassigned: [CommitPart] = []) {
        self.id = id
        self.commits = commits
        self.unassigned = unassigned
    }
}

extension CommitSplitDraftReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, commits, unassigned }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), commits: lenientElements(CommitPlan.self, c, .commits),
                  unassigned: lenientElements(CommitPart.self, c, .unassigned))
    }
}

/// Reply to `commit_series` (`committed_series`) — and, on a `commit_failed` refusal after at least one commit, the
/// refusal's `partial` (`pushed` false): the commits made, oldest first.
public struct CommittedSeries: Sendable, Equatable {
    public var id: String?
    public var commits: [SeriesCommit]
    public var branch: String?
    public var pushed: Bool

    public init(id: String? = nil, commits: [SeriesCommit] = [], branch: String? = nil, pushed: Bool = false) {
        self.id = id
        self.commits = commits
        self.branch = branch
        self.pushed = pushed
    }
}

extension CommittedSeries: Decodable {
    private enum CodingKeys: String, CodingKey { case id, commits, branch, pushed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), commits: lenientElements(SeriesCommit.self, c, .commits),
                  branch: lenientValue(String.self, c, .branch), pushed: lenientValue(Bool.self, c, .pushed) ?? false)
    }
}

// MARK: - Commands

extension EngineCommand {
    private enum CommitSeriesKeys: String, CodingKey { case paths, commits, push }

    /// The §53 commands' fields (`type` is written by the caller).
    func encodeCommitSeriesFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CommitSeriesKeys.self)
        switch self {
        case let .commitHunks(paths), let .commitSplitDraft(paths):
            try c.encodeIfPresent(paths, forKey: .paths)
        case let .commitSeries(commits, push):
            try c.encode(commits, forKey: .commits)
            try c.encodeIfPresent(push, forKey: .push)
        default:
            break
        }
    }
}
