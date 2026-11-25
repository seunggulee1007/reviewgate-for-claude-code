import Foundation

// MARK: git-sync — docs/PROTOCOL.md §68 on the wire (TypeScript: the §68 block of engine/src/protocol.ts): fetch
// (`git_fetch` → `fetched`), a safe pull (`git_pull` → `pulled`) and `state.branches.sync`. Every field is read leniently:
// an older engine sends none of it and refuses the commands `unknown_command`.

/// §68.2: an unfinished git operation in the working tree.
public enum GitOperation: String, Codable, Sendable, Hashable {
    case merge, rebase
    case cherryPick = "cherry-pick"
    case revert
}

/// §68.2: why a pull cannot run right now.
public enum PullBlocker: Sendable, Hashable {
    case running
    case busy
    case detached
    case noUpstream
    case operation(GitOperation)
}

/// §68.1: why a fetch cannot run right now.
public enum FetchBlocker: String, Sendable, Hashable {
    case noRemote
    case busy
}

extension PullBlocker: Codable {
    private enum CodingKeys: String, CodingKey { case kind, operation }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch lenientValue(String.self, c, .kind) {
        case "running": self = .running
        case "busy": self = .busy
        case "detached": self = .detached
        case "noUpstream": self = .noUpstream
        case "operation": self = .operation(lenientValue(String.self, c, .operation).flatMap(GitOperation.init(rawValue:)) ?? .merge)
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown pull blocker")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .running: try c.encode("running", forKey: .kind)
        case .busy: try c.encode("busy", forKey: .kind)
        case .detached: try c.encode("detached", forKey: .kind)
        case .noUpstream: try c.encode("noUpstream", forKey: .kind)
        case .operation(let op):
            try c.encode("operation", forKey: .kind)
            try c.encode(op, forKey: .operation)
        }
    }
}

extension FetchBlocker: Codable {
    private enum CodingKeys: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let kind = lenientValue(String.self, c, .kind).flatMap(FetchBlocker.init(rawValue:)) else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown fetch blocker")
        }
        self = kind
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(rawValue, forKey: .kind)
    }
}

/// `state.branches.sync` (§68.4).
public struct GitSyncState: Sendable, Equatable {
    public var fetching: Bool
    public var pulling: Bool
    /// ISO-8601 of the last successful fetch of this engine.
    public var lastFetchAt: String?
    /// `fetch_failed:<line>` of the last fetch (an automatic one too); nil after a success.
    public var lastFetchError: String?
    public var remotes: [String]
    /// The current branch's upstream (`origin/main`).
    public var upstream: String?
    public var operation: GitOperation?
    public var pullBlocker: PullBlocker?
    public var fetchBlocker: FetchBlocker?
    public var autoFetch: Bool

    public init(fetching: Bool = false, pulling: Bool = false, lastFetchAt: String? = nil, lastFetchError: String? = nil, remotes: [String] = [],
                upstream: String? = nil, operation: GitOperation? = nil, pullBlocker: PullBlocker? = nil, fetchBlocker: FetchBlocker? = nil,
                autoFetch: Bool = true) {
        self.fetching = fetching
        self.pulling = pulling
        self.lastFetchAt = lastFetchAt
        self.lastFetchError = lastFetchError
        self.remotes = remotes
        self.upstream = upstream
        self.operation = operation
        self.pullBlocker = pullBlocker
        self.fetchBlocker = fetchBlocker
        self.autoFetch = autoFetch
    }

    /// A fetch or a pull runs.
    public var isBusy: Bool { fetching || pulling }
}

extension GitSyncState: Codable {
    private enum CodingKeys: String, CodingKey {
        case fetching, pulling, lastFetchAt, lastFetchError, remotes, upstream, operation, pullBlocker, fetchBlocker, autoFetch
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(fetching: lenientValue(Bool.self, c, .fetching) ?? false, pulling: lenientValue(Bool.self, c, .pulling) ?? false,
                  lastFetchAt: lenientValue(String.self, c, .lastFetchAt), lastFetchError: lenientValue(String.self, c, .lastFetchError),
                  remotes: lenientElements(String.self, c, .remotes), upstream: lenientValue(String.self, c, .upstream),
                  operation: lenientValue(String.self, c, .operation).flatMap(GitOperation.init(rawValue:)),
                  pullBlocker: lenientValue(PullBlocker.self, c, .pullBlocker), fetchBlocker: lenientValue(FetchBlocker.self, c, .fetchBlocker),
                  autoFetch: lenientValue(Bool.self, c, .autoFetch) ?? true)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(fetching, forKey: .fetching)
        try c.encode(pulling, forKey: .pulling)
        try c.encode(lastFetchAt, forKey: .lastFetchAt)
        try c.encode(lastFetchError, forKey: .lastFetchError)
        try c.encode(remotes, forKey: .remotes)
        try c.encode(upstream, forKey: .upstream)
        try c.encode(operation, forKey: .operation)
        try c.encode(pullBlocker, forKey: .pullBlocker)
        try c.encode(fetchBlocker, forKey: .fetchBlocker)
        try c.encode(autoFetch, forKey: .autoFetch)
    }
}

/// Reply to `git_fetch`. `skipped`: an automatic fetch that did not run.
public struct FetchedReply: Sendable, Equatable {
    public var id: String?
    public var remotes: [String]
    public var skipped: Bool
    public var ahead: Int?
    public var behind: Int?

    public init(id: String? = nil, remotes: [String] = [], skipped: Bool = false, ahead: Int? = nil, behind: Int? = nil) {
        self.id = id
        self.remotes = remotes
        self.skipped = skipped
        self.ahead = ahead
        self.behind = behind
    }
}

extension FetchedReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, remotes, skipped, ahead, behind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), remotes: lenientElements(String.self, c, .remotes),
                  skipped: lenientValue(Bool.self, c, .skipped) ?? false, ahead: lenientValue(Int.self, c, .ahead),
                  behind: lenientValue(Int.self, c, .behind))
    }
}

/// Reply to `git_pull`.
public struct PulledReply: Sendable, Equatable {
    public enum Mode: String, Sendable { case upToDate = "up_to_date", fastForward = "fast_forward", rebase }

    public var id: String?
    public var branch: String
    public var upstream: String
    public var mode: Mode
    public var from: String
    public var to: String
    public var commits: Int
    public var files: [String]
    public var fileCount: Int

    public init(id: String? = nil, branch: String = "", upstream: String = "", mode: Mode = .upToDate, from: String = "", to: String = "",
                commits: Int = 0, files: [String] = [], fileCount: Int = 0) {
        self.id = id
        self.branch = branch
        self.upstream = upstream
        self.mode = mode
        self.from = from
        self.to = to
        self.commits = commits
        self.files = files
        self.fileCount = fileCount
    }
}

extension PulledReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, branch, upstream, mode, from, to, commits, files, fileCount }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let files = lenientElements(String.self, c, .files)
        self.init(id: lenientValue(String.self, c, .id), branch: lenientValue(String.self, c, .branch) ?? "",
                  upstream: lenientValue(String.self, c, .upstream) ?? "",
                  mode: lenientValue(String.self, c, .mode).flatMap(Mode.init(rawValue:)) ?? .fastForward,
                  from: lenientValue(String.self, c, .from) ?? "", to: lenientValue(String.self, c, .to) ?? "",
                  commits: lenientValue(Int.self, c, .commits) ?? 0, files: files, fileCount: lenientValue(Int.self, c, .fileCount) ?? files.count)
    }
}

// MARK: - Commands

extension EngineCommand {
    private enum GitSyncKeys: String, CodingKey { case all, prune, auto, rebase }

    /// The §68 commands' fields (`type` is written by the caller).
    func encodeGitSyncFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: GitSyncKeys.self)
        switch self {
        case let .gitFetch(all, auto):
            if all { try c.encode(true, forKey: .all) }
            if auto { try c.encode(true, forKey: .auto) }
        case let .gitPull(rebase):
            if rebase { try c.encode(true, forKey: .rebase) }
        default:
            break
        }
    }
}
