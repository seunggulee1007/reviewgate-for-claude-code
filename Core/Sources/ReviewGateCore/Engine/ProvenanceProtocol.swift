import Foundation

// Wire types of docs/PROTOCOL.md §31–§32 (engine/src/protocol.ts): who changed a file (`origin`), the mods group and
// its risks, HEAD moving during a turn, other Claude processes in the worktree, a stale restored review,
// `.claude/settings.local.json` changes, nested repositories a turn touched and the files a snapshot had to skip.
// Every decoder is lenient — a missing key defaults, an unknown value falls back or is dropped — so a newer engine
// never makes a snapshot or an event undecodable.

// MARK: - §31 Origin

/// `changedFiles[].origin` / `turn_summary.files[].origin`: what changed the file. Derived by the engine from the
/// file's causes every time the state is built (never stored).
public enum FileOrigin: String, Sendable, Hashable, CaseIterable {
    /// An edit tool (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) or an MCP call changed it.
    case tool
    /// A Bash call changed it (its change time fell inside the call's execution window).
    case bash
    /// MARK: r2-skills-side — §31.1 (M35): a skill's own work — a `!`command`` line of a SKILL.md / command .md, run while
    /// Claude Code loaded it (a `Skill` call's window, or a slash command's turn before its first tool call: cause id
    /// `skill:<name>`, `SkillCause`). "Reject all" reverts it with Claude's changes.
    case skill
    /// Nothing of Claude's explains it: an IDE save, another Claude session, `git pull`, work done while the app was
    /// closed. "Reject all" leaves these files alone unless the user explicitly includes them.
    case external

    /// nil for a missing or unknown value (a newer engine): the file is then shown like an ordinary Claude change.
    public init?(lenient raw: String?) {
        guard let raw, let origin = FileOrigin(rawValue: raw) else { return nil }
        self = origin
    }
}

/// MARK: r2-skills-side — §31.1 (M35): the cause id of a slash command's own work, `skill:<name>` — what its !`command`
/// lines changed while Claude Code loaded it (no tool call, so no transcript row). A `Skill` call's cause is its tool_use id.
public enum SkillCause {
    static let prefix = "skill:"

    /// `skill:acme-verify` → `acme-verify`; nil for any other id.
    public static func command(of id: String) -> String? {
        guard id.hasPrefix(prefix), id.count > prefix.count else { return nil }
        return String(id.dropFirst(prefix.count))
    }
}

// MARK: - §32 Mods paths

/// `changedFiles[].group`: the files that change how Claude Code itself behaves (`.claude/**`, `.mcp.json`,
/// `CLAUDE.md`, `CLAUDE.local.md`); unknown groups decode as nil.
public enum ChangedFileGroup: String, Sendable, Hashable {
    case mods
}

/// `changedFiles[].risk` (mods files only): what the change makes run or lets through. Unknown values are kept as
/// `.other` so a newer engine's warning is still shown.
public enum ModsRisk: Sendable, Hashable {
    /// `hooks.json`, anything under `.claude/hooks/`, a settings file whose `hooks` / `statusLine` changed.
    case hook
    /// An executable or a script under `.claude/`.
    case script
    /// `.mcp.json`, or a settings file's MCP server keys.
    case mcp
    /// A settings file's `permissions`.
    case permissions
    /// A settings file's `env` / `apiKeyHelper`.
    case env
    case other(String)

    public init(raw: String) {
        switch raw {
        case "hook": self = .hook
        case "script": self = .script
        case "mcp": self = .mcp
        case "permissions": self = .permissions
        case "env": self = .env
        default: self = .other(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .hook: "hook"
        case .script: "script"
        case .mcp: "mcp"
        case .permissions: "permissions"
        case .env: "env"
        case let .other(raw): raw
        }
    }
}

/// The §31–32 fields of one `changedFiles[]` entry, decoded on their own so a bad value never fails the file.
struct ChangedFileProvenance: Decodable {
    var origin: FileOrigin?
    var group: ChangedFileGroup?
    var risk: [ModsRisk] = []
    var uncaptured = false
    var ignored = false

    private enum CodingKeys: String, CodingKey { case origin, group, risk, uncaptured, ignored }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        origin = FileOrigin(lenient: try? c.decodeIfPresent(String.self, forKey: .origin))
        group = (try? c.decodeIfPresent(String.self, forKey: .group)).flatMap(ChangedFileGroup.init(rawValue:))
        risk = provenanceList(String.self, c, .risk).map(ModsRisk.init(raw:))
        uncaptured = (try? c.decodeIfPresent(Bool.self, forKey: .uncaptured)) ?? false
        ignored = (try? c.decodeIfPresent(Bool.self, forKey: .ignored)) ?? false
    }

    /// Never throws: a container that is not an object yields the defaults.
    static func lenient(from decoder: Decoder) -> ChangedFileProvenance {
        (try? ChangedFileProvenance(from: decoder)) ?? ChangedFileProvenance()
    }

    private init() {}
}

// MARK: - §31 HEAD

/// A commit (`sha` nil: unborn HEAD) and branch (nil: detached).
public struct HeadInfo: Codable, Sendable, Hashable {
    public var sha: String?
    public var branch: String?

    public init(sha: String?, branch: String?) {
        self.sha = sha
        self.branch = branch
    }

    private enum CodingKeys: String, CodingKey { case sha, branch }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(sha: try? c.decodeIfPresent(String.self, forKey: .sha),
                  branch: try? c.decodeIfPresent(String.self, forKey: .branch))
    }

    /// The first 7 characters of the commit; nil for an unborn HEAD.
    public var shortSha: String? { sha.map { String($0.prefix(7)) } }
}

/// `state.gate.headMoved` / the `head_moved` event: HEAD (commit and / or branch) before and after the turn.
public struct HeadMove: Codable, Sendable, Hashable {
    public var from: HeadInfo
    public var to: HeadInfo
    // MARK: r1-git — §31.3 / §46 (`head_moved` only; nil / empty from an older engine)
    /// `claude_git`: Claude's own git commands made the move — no bar (the engine sets no `gate.headMoved`), a chat row.
    public var explainedBy: String?
    /// With `explainedBy`: the short shas of the commits Claude made in the turn, oldest first.
    public var commits: [String] = []

    public init(from: HeadInfo, to: HeadInfo, explainedBy: String? = nil, commits: [String] = []) {
        self.from = from
        self.to = to
        self.explainedBy = explainedBy
        self.commits = commits
    }

    private enum CodingKeys: String, CodingKey { case from, to, explainedBy, commits }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(from: (try? c.decodeIfPresent(HeadInfo.self, forKey: .from)) ?? HeadInfo(sha: nil, branch: nil),
                  to: (try? c.decodeIfPresent(HeadInfo.self, forKey: .to)) ?? HeadInfo(sha: nil, branch: nil),
                  explainedBy: (try? c.decodeIfPresent(String.self, forKey: .explainedBy)) ?? nil,
                  commits: ((try? c.decodeIfPresent([String].self, forKey: .commits)) ?? nil) ?? [])
    }

    /// Claude's own git commands made it (§31.3): a chat row, never the head-moved bar.
    public var isClaudesOwn: Bool { explainedBy == "claude_git" }
}

// MARK: - §31 Other Claude processes

/// Another Claude Code process whose working folder is this worktree (its `~/.claude/sessions/<pid>.json` entry).
public struct ConcurrentClaude: Codable, Sendable, Hashable, Identifiable {
    public var pid: Int
    public var sessionId: String?
    public var cwd: String
    /// The CLI's session name ("acme-b4"), as `claude --resume` and peer messages show it.
    public var name: String?
    public var kind: String?
    /// `cli` (a terminal), `sdk-cli` / `sdk-ts` (an app or a script on the SDK), …
    public var entrypoint: String?
    /// `busy` / `idle` / … as the CLI last wrote it.
    public var status: String?
    /// ISO-8601.
    public var startedAt: String?

    public var id: String { "\(pid)@\(startedAt ?? "")" }

    public init(pid: Int, sessionId: String? = nil, cwd: String = "", name: String? = nil, kind: String? = nil,
                entrypoint: String? = nil, status: String? = nil, startedAt: String? = nil) {
        self.pid = pid
        self.sessionId = sessionId
        self.cwd = cwd
        self.name = name
        self.kind = kind
        self.entrypoint = entrypoint
        self.status = status
        self.startedAt = startedAt
    }

    private enum CodingKeys: String, CodingKey { case pid, sessionId, cwd, name, kind, entrypoint, status, startedAt }

    /// `pid` is required: an entry without one is dropped by the list decoder.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(pid: try c.decode(Int.self, forKey: .pid),
                  sessionId: try? c.decodeIfPresent(String.self, forKey: .sessionId),
                  cwd: (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? "",
                  name: try? c.decodeIfPresent(String.self, forKey: .name),
                  kind: try? c.decodeIfPresent(String.self, forKey: .kind),
                  entrypoint: try? c.decodeIfPresent(String.self, forKey: .entrypoint),
                  status: try? c.decodeIfPresent(String.self, forKey: .status),
                  startedAt: try? c.decodeIfPresent(String.self, forKey: .startedAt))
    }

    /// A terminal session (`entrypoint == "cli"`); anything else is an app or a script on the SDK.
    public var isTerminal: Bool { entrypoint == "cli" }
}

// MARK: - §31 Stale restored review

/// Why a restored review is stale. Unknown reasons are kept so the sheet still opens.
public enum StaleReason: Sendable, Hashable {
    /// HEAD moved since the review was saved (a commit, pull or checkout outside the app).
    case headMoved
    /// Saved 12 h or more ago.
    case old
    case other(String)

    public init(raw: String) {
        switch raw {
        case "head_moved": self = .headMoved
        case "old": self = .old
        default: self = .other(raw)
        }
    }
}

/// `state.gate.stale`: the review `open_project` restored is stale — the client asks "정리 / 이어서 리뷰".
public struct StaleReview: Decodable, Sendable, Hashable {
    public var reasons: [StaleReason]
    /// ISO-8601: when the review was last saved.
    public var savedAt: String
    /// HEAD then (nil: a file written before §31).
    public var savedHead: HeadInfo?
    /// HEAD now.
    public var head: HeadInfo?
    /// Restored files with origin `external` (changed while the app was closed).
    public var externalFiles: Int

    public init(reasons: [StaleReason], savedAt: String = "", savedHead: HeadInfo? = nil, head: HeadInfo? = nil, externalFiles: Int = 0) {
        self.reasons = reasons
        self.savedAt = savedAt
        self.savedHead = savedHead
        self.head = head
        self.externalFiles = externalFiles
    }

    private enum CodingKeys: String, CodingKey { case reasons, savedAt, savedHead, head, externalFiles }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(reasons: provenanceList(String.self, c, .reasons).map(StaleReason.init(raw:)),
                  savedAt: (try? c.decodeIfPresent(String.self, forKey: .savedAt)) ?? "",
                  savedHead: try? c.decodeIfPresent(HeadInfo.self, forKey: .savedHead),
                  head: try? c.decodeIfPresent(HeadInfo.self, forKey: .head),
                  externalFiles: (try? c.decodeIfPresent(Int.self, forKey: .externalFiles)) ?? 0)
    }

    public var savedDate: Date? { isoDate(savedAt) }
}

// MARK: - §32 settings.local.json

/// `state.gate.localSettingsChanged`: which parts of `.claude/settings.local.json` the last turn changed (compared by
/// hash only — the file is never captured, so there is no diff and no revert).
public struct LocalSettingsChange: Codable, Sendable, Hashable {
    public var path: String
    public var hooks: Bool
    public var permissions: Bool
    public var env: Bool
    public var mcp: Bool

    public init(path: String = ".claude/settings.local.json", hooks: Bool = false, permissions: Bool = false, env: Bool = false, mcp: Bool = false) {
        self.path = path
        self.hooks = hooks
        self.permissions = permissions
        self.env = env
        self.mcp = mcp
    }

    private enum CodingKeys: String, CodingKey { case path, hooks, permissions, env, mcp }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func flag(_ key: CodingKeys) -> Bool { (try? c.decodeIfPresent(Bool.self, forKey: key)) ?? false }
        self.init(path: (try? c.decodeIfPresent(String.self, forKey: .path)) ?? ".claude/settings.local.json",
                  hooks: flag(.hooks), permissions: flag(.permissions), env: flag(.env), mcp: flag(.mcp))
    }
}

// MARK: - §32 Nested repositories

/// What a nested repository is. Unknown kinds are kept as `.other`.
public enum NestedKind: Sendable, Hashable {
    /// A linked worktree of this repository (`.claude/worktrees/*` — EnterWorktree, Workflow, isolated agents).
    case worktree
    case submodule
    /// Another clone (or any other `.git` folder) inside the project.
    case repo
    case other(String)

    public init(raw: String) {
        switch raw {
        case "worktree": self = .worktree
        case "submodule": self = .submodule
        case "repo": self = .repo
        default: self = .other(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .worktree: "worktree"
        case .submodule: "submodule"
        case .repo: "repo"
        case let .other(raw): raw
        }
    }
}

/// A nested repository's HEAD before and after the turn.
public struct NestedHeadMove: Codable, Sendable, Hashable {
    public var from: String
    public var to: String

    public init(from: String, to: String) {
        self.from = from
        self.to = to
    }
}

/// `state.gate.nestedChanges[]`: a repository inside the project the last turn touched — its changes are outside this
/// review ("리뷰 밖 변경").
public struct NestedChange: Decodable, Sendable, Hashable, Identifiable {
    /// Repo-relative (POSIX) path of the nested repository.
    public var path: String
    public var kind: NestedKind
    /// Its branch now (nil: detached / unknown).
    public var branch: String?
    /// Its HEAD moved during the turn.
    public var head: NestedHeadMove?
    /// `git status` entries in it now; nil when git did not answer within 3 s.
    public var dirtyFiles: Int?
    /// Project-relative files the turn's edit tools changed in it (≤ 20).
    public var touchedFiles: [String]
    /// How the turn reached it: `edit`, `bash`, `mcp`.
    public var via: [String]

    public var id: String { path }

    public init(path: String, kind: NestedKind = .repo, branch: String? = nil, head: NestedHeadMove? = nil, dirtyFiles: Int? = nil,
                touchedFiles: [String] = [], via: [String] = []) {
        self.path = path
        self.kind = kind
        self.branch = branch
        self.head = head
        self.dirtyFiles = dirtyFiles
        self.touchedFiles = touchedFiles
        self.via = via
    }

    private enum CodingKeys: String, CodingKey { case path, kind, branch, head, dirtyFiles, touchedFiles, via }

    /// `path` is required: an entry without one is dropped by the list decoder.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(path: try c.decode(String.self, forKey: .path),
                  kind: NestedKind(raw: (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "repo"),
                  branch: try? c.decodeIfPresent(String.self, forKey: .branch),
                  head: try? c.decodeIfPresent(NestedHeadMove.self, forKey: .head),
                  dirtyFiles: try? c.decodeIfPresent(Int.self, forKey: .dirtyFiles),
                  touchedFiles: provenanceList(String.self, c, .touchedFiles),
                  via: provenanceList(String.self, c, .via))
    }
}

// MARK: - §32 Skipped files

/// `state.gate.snapshotSkipped[]`: a file the turn's snapshots had to leave out (git could not read it — a root-owned
/// log a container wrote). Its review entry, if any, is `uncaptured`.
public struct SkippedPath: Codable, Sendable, Hashable, Identifiable {
    public var path: String
    /// `unreadable` (the only reason this engine reports).
    public var reason: String

    public var id: String { path }

    public init(path: String, reason: String = "unreadable") {
        self.path = path
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey { case path, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(path: try c.decode(String.self, forKey: .path),
                  reason: (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? "unreadable")
    }
}

// MARK: - The §31–32 part of `state.gate`

/// The §31–32 fields of `state.gate`, decoded on their own so a bad value never fails the gate.
struct GateProvenance: Decodable {
    var externalPendingCount = 0
    var headMoved: HeadMove?
    var concurrentClaude: [ConcurrentClaude] = []
    var stale: StaleReview?
    var localSettingsChanged: LocalSettingsChange?
    var nestedChanges: [NestedChange] = []
    var snapshotSkipped: [SkippedPath] = []

    private enum CodingKeys: String, CodingKey {
        case externalPendingCount, headMoved, concurrentClaude, stale, localSettingsChanged, nestedChanges, snapshotSkipped
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        externalPendingCount = max(0, (try? c.decodeIfPresent(Int.self, forKey: .externalPendingCount)) ?? 0)
        headMoved = try? c.decodeIfPresent(HeadMove.self, forKey: .headMoved)
        concurrentClaude = provenanceList(ConcurrentClaude.self, c, .concurrentClaude)
        stale = try? c.decodeIfPresent(StaleReview.self, forKey: .stale)
        localSettingsChanged = try? c.decodeIfPresent(LocalSettingsChange.self, forKey: .localSettingsChanged)
        nestedChanges = provenanceList(NestedChange.self, c, .nestedChanges)
        snapshotSkipped = provenanceList(SkippedPath.self, c, .snapshotSkipped)
    }

    /// Never throws: a gate that is not an object yields the defaults.
    static func lenient(from decoder: Decoder) -> GateProvenance {
        (try? GateProvenance(from: decoder)) ?? GateProvenance()
    }

    private init() {}
}

// MARK: - Events

/// `head_moved {turn, from, to}`: HEAD moved between the start and the end of turn `turn` (after its `turn_end`).
public struct HeadMovedEvent: Sendable, Equatable {
    public var turn: Int
    public var move: HeadMove

    public init(turn: Int, move: HeadMove) {
        self.turn = turn
        self.move = move
    }
}

/// `concurrent_claude {at, sessions}`: other Claude processes work in this worktree (sent at open and on every send while
/// there are any).
public struct ConcurrentClaudeEvent: Sendable, Equatable {
    /// `open` / `send`.
    public var at: String
    public var sessions: [ConcurrentClaude]

    public init(at: String, sessions: [ConcurrentClaude]) {
        self.at = at
        self.sessions = sessions
    }
}

/// `local_settings_changed {turn, path, hooks, permissions, env, mcp}`.
public struct LocalSettingsChangedEvent: Sendable, Equatable {
    public var turn: Int
    public var change: LocalSettingsChange

    public init(turn: Int, change: LocalSettingsChange) {
        self.turn = turn
        self.change = change
    }
}

/// `nested_changes {turn, repos}`.
public struct NestedChangesEvent: Sendable, Equatable {
    public var turn: Int
    public var repos: [NestedChange]

    public init(turn: Int, repos: [NestedChange]) {
        self.turn = turn
        self.repos = repos
    }
}

/// Decodes the payloads of the four §31–32 events and `turn_end.external` with their own keys.
enum ProvenanceEvents {
    private enum Keys: String, CodingKey { case turn, from, to, at, sessions, repos, external }

    static func headMoved(_ decoder: Decoder) throws -> HeadMovedEvent {
        let c = try decoder.container(keyedBy: Keys.self)
        let move = (try? HeadMove(from: decoder)) ?? HeadMove(from: HeadInfo(sha: nil, branch: nil), to: HeadInfo(sha: nil, branch: nil))
        return HeadMovedEvent(turn: (try? c.decodeIfPresent(Int.self, forKey: .turn)) ?? 0, move: move)
    }

    static func concurrentClaude(_ decoder: Decoder) throws -> ConcurrentClaudeEvent {
        let c = try decoder.container(keyedBy: Keys.self)
        return ConcurrentClaudeEvent(at: (try? c.decodeIfPresent(String.self, forKey: .at)) ?? "send",
                                     sessions: provenanceList(ConcurrentClaude.self, c, .sessions))
    }

    static func localSettingsChanged(_ decoder: Decoder) throws -> LocalSettingsChangedEvent {
        let c = try decoder.container(keyedBy: Keys.self)
        return LocalSettingsChangedEvent(turn: (try? c.decodeIfPresent(Int.self, forKey: .turn)) ?? 0,
                                         change: (try? LocalSettingsChange(from: decoder)) ?? LocalSettingsChange())
    }

    static func nestedChanges(_ decoder: Decoder) throws -> NestedChangesEvent {
        let c = try decoder.container(keyedBy: Keys.self)
        return NestedChangesEvent(turn: (try? c.decodeIfPresent(Int.self, forKey: .turn)) ?? 0,
                                  repos: provenanceList(NestedChange.self, c, .repos))
    }

    /// `turn_end.external` (§31, also on the transcript's `turn_end` row): 0 when absent or not a number.
    static func external(_ decoder: Decoder) -> Int {
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return 0 }
        return max(0, (try? c.decodeIfPresent(Int.self, forKey: .external)) ?? 0)
    }
}

/// Decodes `[T]` element by element, dropping the elements that do not decode (one odd entry never hides the rest).
func provenanceList<T: Decodable, K: CodingKey>(_ type: T.Type, _ c: KeyedDecodingContainer<K>, _ key: K) -> [T] {
    guard var list = try? c.nestedUnkeyedContainer(forKey: key) else { return [] }
    var out: [T] = []
    while !list.isAtEnd {
        if let item = try? list.decode(T.self) {
            out.append(item)
        } else if (try? list.decode(JSONValue.self)) == nil {
            break
        }
    }
    return out
}
