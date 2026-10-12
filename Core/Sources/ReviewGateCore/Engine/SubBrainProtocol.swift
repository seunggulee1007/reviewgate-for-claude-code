import Foundation

// MARK: wave5 w5-brain — docs/PROTOCOL.md §43.2: the sub-brain (Claude Code's auto memory of the repository), read only.
// Every field is lenient: an older engine never sends `brain` (it refuses the command `unknown_command`).

/// What kind of memory a file is (frontmatter `type`, else the file name's prefix).
public enum BrainMemoryType: String, Sendable, Equatable, CaseIterable, Codable {
    case user, feedback, project, reference, other

    /// The four kinds the board counts in cards, then the rest.
    public static let shown: [BrainMemoryType] = [.user, .feedback, .project, .reference]

    public init(lenient raw: String?) {
        self = raw.flatMap { BrainMemoryType(rawValue: $0.lowercased()) } ?? .other
    }
}

public enum BrainChangeKind: String, Sendable, Equatable, Codable {
    case add, change, remove
}

/// One memory file (`<memory dir>/<name>.md`).
public struct BrainMemory: Sendable, Equatable, Identifiable, Decodable {
    public var name: String
    public var title: String?
    public var type: BrainMemoryType
    public var description: String
    /// epoch ms
    public var mtime: Double
    public var size: Int
    public var indexed: Bool
    /// The memories its [[links]] reach.
    public var links: [String]
    /// Added or changed during this session (nil: neither).
    public var session: BrainChangeKind?

    public var id: String { name }
    /// What the board calls it: the frontmatter `name`, else the file name.
    public var label: String { (title?.isEmpty == false ? title : nil) ?? name }

    public init(name: String, title: String? = nil, type: BrainMemoryType = .other, description: String = "", mtime: Double = 0, size: Int = 0,
                indexed: Bool = false, links: [String] = [], session: BrainChangeKind? = nil) {
        self.name = name
        self.title = title
        self.type = type
        self.description = description
        self.mtime = mtime
        self.size = size
        self.indexed = indexed
        self.links = links
        self.session = session
    }

    private enum CodingKeys: String, CodingKey { case name, title, type, description, mtime, size, indexed, links, session }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let name = lenientValue(String.self, c, .name), !name.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "a memory without a name")
        }
        self.init(name: name,
                  title: lenientValue(String.self, c, .title),
                  type: BrainMemoryType(lenient: lenientValue(String.self, c, .type)),
                  description: lenientValue(String.self, c, .description) ?? "",
                  mtime: lenientValue(Double.self, c, .mtime) ?? 0,
                  size: lenientValue(Int.self, c, .size) ?? 0,
                  indexed: lenientValue(Bool.self, c, .indexed) ?? false,
                  links: lenientValue([String].self, c, .links) ?? [],
                  session: lenientValue(String.self, c, .session).flatMap(BrainChangeKind.init(rawValue:)))
    }
}

/// Who wrote a memory: Claude, a subagent (`agentType`), or someone the engine did not see.
public enum BrainWriter: String, Sendable, Equatable, Codable {
    case main, agent, external
}

/// A memory added, changed or removed during this session.
public struct BrainChange: Sendable, Equatable, Identifiable, Decodable {
    public var at: Double
    public var kind: BrainChangeKind
    public var name: String
    public var title: String?
    public var type: BrainMemoryType
    public var description: String
    public var by: BrainWriter
    public var agentType: String?

    public var id: String { "\(at)-\(kind.rawValue)-\(name)" }
    public var label: String { (title?.isEmpty == false ? title : nil) ?? name }

    public init(at: Double, kind: BrainChangeKind, name: String, title: String? = nil, type: BrainMemoryType = .other, description: String = "",
                by: BrainWriter = .external, agentType: String? = nil) {
        self.at = at
        self.kind = kind
        self.name = name
        self.title = title
        self.type = type
        self.description = description
        self.by = by
        self.agentType = agentType
    }

    private enum CodingKeys: String, CodingKey { case at, kind, name, title, type, description, by, agentType }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let name = lenientValue(String.self, c, .name),
              let kind = lenientValue(String.self, c, .kind).flatMap(BrainChangeKind.init(rawValue:)) else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "a change without a name or kind")
        }
        self.init(at: lenientValue(Double.self, c, .at) ?? 0, kind: kind, name: name,
                  title: lenientValue(String.self, c, .title),
                  type: BrainMemoryType(lenient: lenientValue(String.self, c, .type)),
                  description: lenientValue(String.self, c, .description) ?? "",
                  by: lenientValue(String.self, c, .by).flatMap(BrainWriter.init(rawValue:)) ?? .external,
                  agentType: lenientValue(String.self, c, .agentType))
    }
}

public struct BrainBrokenLink: Sendable, Equatable, Decodable, Hashable {
    public var from: String
    public var to: String

    public init(from: String, to: String) {
        self.from = from
        self.to = to
    }
}

public struct BrainTally: Sendable, Equatable, Decodable {
    public var add: Int
    public var change: Int
    public var remove: Int

    public init(add: Int = 0, change: Int = 0, remove: Int = 0) {
        self.add = add
        self.change = change
        self.remove = remove
    }

    private enum CodingKeys: String, CodingKey { case add, change, remove }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(add: lenientValue(Int.self, c, .add) ?? 0, change: lenientValue(Int.self, c, .change) ?? 0, remove: lenientValue(Int.self, c, .remove) ?? 0)
    }
}

/// Reply to `brain` (and each change of a watched folder).
public struct BrainSnapshot: Sendable, Equatable, Decodable {
    public var id: String?
    /// The memory folder; nil without a project.
    public var dir: String?
    public var dirSource: String?
    public var exists: Bool
    /// Newest first.
    public var memories: [BrainMemory]
    public var hasIndex: Bool
    public var unindexed: [String]
    public var missing: [String]
    public var brokenLinks: [BrainBrokenLink]
    /// Newest first.
    public var changes: [BrainChange]
    public var tally: BrainTally
    public var sessionCount: Int
    public var baselineAt: Double?
    public var scannedAt: Double?
    public var truncated: Bool
    public var error: String?
    public var watching: Bool

    public init(id: String? = nil, dir: String? = nil, dirSource: String? = nil, exists: Bool = false, memories: [BrainMemory] = [], hasIndex: Bool = false,
                unindexed: [String] = [], missing: [String] = [], brokenLinks: [BrainBrokenLink] = [], changes: [BrainChange] = [],
                tally: BrainTally = BrainTally(), sessionCount: Int = 0, baselineAt: Double? = nil, scannedAt: Double? = nil,
                truncated: Bool = false, error: String? = nil, watching: Bool = false) {
        self.id = id
        self.dir = dir
        self.dirSource = dirSource
        self.exists = exists
        self.memories = memories
        self.hasIndex = hasIndex
        self.unindexed = unindexed
        self.missing = missing
        self.brokenLinks = brokenLinks
        self.changes = changes
        self.tally = tally
        self.sessionCount = sessionCount
        self.baselineAt = baselineAt
        self.scannedAt = scannedAt
        self.truncated = truncated
        self.error = error
        self.watching = watching
    }

    private enum CodingKeys: String, CodingKey {
        case id, dir, dirSource, exists, memories, hasIndex, unindexed, missing, brokenLinks, changes, tally, sessionCount, baselineAt, scannedAt
        case truncated, error, watching
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id),
                  dir: lenientValue(String.self, c, .dir),
                  dirSource: lenientValue(String.self, c, .dirSource),
                  exists: lenientValue(Bool.self, c, .exists) ?? false,
                  memories: lenientElements(BrainMemory.self, c, .memories),
                  hasIndex: lenientValue(Bool.self, c, .hasIndex) ?? false,
                  unindexed: lenientValue([String].self, c, .unindexed) ?? [],
                  missing: lenientValue([String].self, c, .missing) ?? [],
                  brokenLinks: lenientElements(BrainBrokenLink.self, c, .brokenLinks),
                  changes: lenientElements(BrainChange.self, c, .changes),
                  tally: lenientValue(BrainTally.self, c, .tally) ?? BrainTally(),
                  sessionCount: lenientValue(Int.self, c, .sessionCount) ?? 0,
                  baselineAt: lenientValue(Double.self, c, .baselineAt),
                  scannedAt: lenientValue(Double.self, c, .scannedAt),
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false,
                  error: lenientValue(String.self, c, .error),
                  watching: lenientValue(Bool.self, c, .watching) ?? false)
    }

    /// The count per kind (the engine's `counts`, recomputed from the list: one rule).
    public func count(_ type: BrainMemoryType) -> Int { memories.filter { $0.type == type }.count }
}

/// Reply to `brain_read`: one memory's text.
public struct BrainMemoryText: Sendable, Equatable, Decodable {
    public var id: String?
    public var name: String
    public var path: String
    public var text: String
    public var truncated: Bool

    public init(id: String? = nil, name: String, path: String, text: String, truncated: Bool = false) {
        self.id = id
        self.name = name
        self.path = path
        self.text = text
        self.truncated = truncated
    }

    private enum CodingKeys: String, CodingKey { case id, name, path, text, truncated }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id),
                  name: lenientValue(String.self, c, .name) ?? "",
                  path: lenientValue(String.self, c, .path) ?? "",
                  text: lenientValue(String.self, c, .text) ?? "",
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false)
    }
}
