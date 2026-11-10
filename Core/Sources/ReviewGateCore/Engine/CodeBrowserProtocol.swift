// MARK: code-browser — docs/PROTOCOL.md §47: reading and searching any file of the open project on the wire. Every field
// is read leniently: an odd value never fails the whole reply.
import Foundation

/// Reply to `project_file`: the worktree file as lines (none when `isBinary`); `truncated` when only its first 2 MB /
/// 20 000 lines came.
public struct ProjectFileReply: Sendable, Equatable, Decodable {
    public var id: String?
    /// Repo-relative, as the engine resolved it.
    public var path: String
    public var lines: [String]
    public var isBinary: Bool
    public var truncated: Bool
    /// The file's size in bytes.
    public var size: Int

    public init(id: String? = nil, path: String, lines: [String], isBinary: Bool = false, truncated: Bool = false, size: Int = 0) {
        self.id = id
        self.path = path
        self.lines = lines
        self.isBinary = isBinary
        self.truncated = truncated
        self.size = size
    }

    private enum CodingKeys: String, CodingKey { case id, path, lines, isBinary, truncated, size }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), path: lenientValue(String.self, c, .path) ?? "",
                  lines: lenientValue([String].self, c, .lines) ?? [], isBinary: lenientValue(Bool.self, c, .isBinary) ?? false,
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false, size: lenientValue(Int.self, c, .size) ?? 0)
    }
}

/// One matching line of `project_search`: repo-relative path, 1-based line, its text (≤ 400 characters around the first
/// match, "…" where the engine cut it).
public struct ProjectSearchMatch: Sendable, Equatable, Hashable, Decodable {
    public var path: String
    public var line: Int
    public var text: String

    public init(path: String, line: Int, text: String) {
        self.path = path
        self.line = line
        self.text = text
    }
}

/// Reply to `project_search`: the matches in git's order (file by file); `truncated` past the limit, `timedOut` when git
/// was stopped after 20 s.
public struct ProjectSearchReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var query: String
    public var matches: [ProjectSearchMatch]
    public var truncated: Bool
    public var timedOut: Bool

    public init(id: String? = nil, query: String, matches: [ProjectSearchMatch], truncated: Bool = false, timedOut: Bool = false) {
        self.id = id
        self.query = query
        self.matches = matches
        self.truncated = truncated
        self.timedOut = timedOut
    }

    private enum CodingKeys: String, CodingKey { case id, query, matches, truncated, timedOut }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), query: lenientValue(String.self, c, .query) ?? "",
                  matches: lenientElements(ProjectSearchMatch.self, c, .matches),
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false, timedOut: lenientValue(Bool.self, c, .timedOut) ?? false)
    }
}
