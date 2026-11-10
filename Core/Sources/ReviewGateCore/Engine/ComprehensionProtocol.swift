import Foundation

// Wire types of docs/PROTOCOL.md §14–17 (engine/src/protocol.ts): review history, the turn summary with plan vs
// actual, the user extensions a session applied, and hunk-level reject. Every decoder is lenient — missing fields
// default, unknown enum values fall back — so a newer engine never makes a snapshot or an event undecodable.

/// An ISO-8601 string as the engine writes it (`new Date().toISOString()`), with or without fractional seconds.
func isoDate(_ s: String) -> Date? {
    if let d = try? Date(s, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
    return try? Date(s, strategy: Date.ISO8601FormatStyle())
}

extension FileReviewState {
    /// A state this client does not know (a newer engine) reads as `.pending`: the file stays under review and keeps
    /// the gate closed instead of making the whole snapshot undecodable.
    init(lenient raw: String?) {
        self = raw.flatMap(FileReviewState.init(rawValue:)) ?? .pending
    }
}

// MARK: - §14 Review history

/// A file's final verdict in a review round; `.pending` when the round ended unresolved (and for unknown values).
public enum HistoryVerdict: String, Sendable, Hashable, CaseIterable, Codable {
    case accepted, rejected
    case changesRequested = "changes_requested"
    case pending

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = HistoryVerdict(rawValue: raw) ?? .pending
    }

    public var displayName: String {
        switch self {
        case .accepted: String(localized: "Accepted", bundle: .module)
        case .rejected: String(localized: "Rejected", bundle: .module)
        case .changesRequested: String(localized: "Changes requested", bundle: .module)
        case .pending: String(localized: "Unresolved", bundle: .module)
        }
    }
}

public struct ReviewHistoryFile: Codable, Sendable, Hashable, Identifiable {
    public var id: String { path }
    public var path: String
    public var oldPath: String?
    public var status: ChangeStatus
    public var verdict: HistoryVerdict
    public var adds: Int
    public var dels: Int
    public var toolUseIds: [String]
    /// Times the file was sent back with notes during the round.
    public var changesRequested: Int
    /// Hunks reverted with `reject_hunks` (§17).
    public var rejectedHunks: Int
    /// A rejected file: the turn-end tree that still held the proposal.
    public var endTree: String?
    /// Left the review through `commit`.
    public var committed: Bool
    // MARK: wave4 w4-history
    /// §38.3: the commit it left the review with (nil: not committed, or an engine before §38.3).
    public var commit: HistoryCommit?
    // MARK: wave4c w4c-trust
    /// §41.2: accepted by this rule, not by the user.
    public var autoAccepted: String?

    public init(path: String, oldPath: String? = nil, status: ChangeStatus = .modified, verdict: HistoryVerdict, adds: Int = 0, dels: Int = 0,
                toolUseIds: [String] = [], changesRequested: Int = 0, rejectedHunks: Int = 0, endTree: String? = nil, committed: Bool = false) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.verdict = verdict
        self.adds = adds
        self.dels = dels
        self.toolUseIds = toolUseIds
        self.changesRequested = changesRequested
        self.rejectedHunks = rejectedHunks
        self.endTree = endTree
        self.committed = committed
    }

    private enum CodingKeys: String, CodingKey {
        case path, oldPath, status, verdict, adds, dels, toolUseIds, changesRequested, rejectedHunks, endTree, committed
    }
    private enum HistoryKeys: String, CodingKey { case commit }   // wave4 w4-history

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            path: try c.decode(String.self, forKey: .path),
            oldPath: try c.decodeIfPresent(String.self, forKey: .oldPath),
            status: (try? c.decodeIfPresent(String.self, forKey: .status)).flatMap { $0.flatMap(ChangeStatus.init(rawValue:)) } ?? .other,
            verdict: (try? c.decodeIfPresent(HistoryVerdict.self, forKey: .verdict)) ?? .pending,
            adds: try c.decodeIfPresent(Int.self, forKey: .adds) ?? 0,
            dels: try c.decodeIfPresent(Int.self, forKey: .dels) ?? 0,
            toolUseIds: try c.decodeIfPresent([String].self, forKey: .toolUseIds) ?? [],
            changesRequested: try c.decodeIfPresent(Int.self, forKey: .changesRequested) ?? 0,
            rejectedHunks: try c.decodeIfPresent(Int.self, forKey: .rejectedHunks) ?? 0,
            endTree: try c.decodeIfPresent(String.self, forKey: .endTree),
            committed: try c.decodeIfPresent(Bool.self, forKey: .committed) ?? false)
        // MARK: wave4 w4-history (§38.3)
        commit = (try? decoder.container(keyedBy: HistoryKeys.self).decodeIfPresent(HistoryCommit.self, forKey: .commit)) ?? nil
        autoAccepted = TrustWire.autoAccepted(from: decoder)   // MARK: wave4c w4c-trust (§41.2)
    }
}

/// A note sent with `request_changes` during the round.
public struct ReviewHistoryNote: Codable, Sendable, Hashable {
    public var path: String
    public var line: Int?
    public var side: DiffSide
    public var body: String

    public init(path: String, line: Int?, side: DiffSide = .new, body: String) {
        self.path = path
        self.line = line
        self.side = side
        self.body = body
    }

    private enum CodingKeys: String, CodingKey { case path, line, side, body }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(path: try c.decodeIfPresent(String.self, forKey: .path) ?? "",
                  line: try c.decodeIfPresent(Int.self, forKey: .line),
                  side: (try? c.decodeIfPresent(DiffSide.self, forKey: .side)) ?? .new,
                  body: try c.decodeIfPresent(String.self, forKey: .body) ?? "")
    }
}

/// One completed review round (docs/PROTOCOL.md §14).
public struct ReviewHistoryEntry: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var sessionId: String?
    /// Transcript turn numbers the round spans.
    public var turns: [Int]
    /// ISO-8601.
    public var startedAt: String
    public var endedAt: String
    /// The first turn's prompt, ≤ 200 chars.
    public var prompt: String
    public var files: [ReviewHistoryFile]
    public var notes: [ReviewHistoryNote]
    public var turnStartTree: String
    public var turnEndTree: String
    // MARK: wave1 mac-review
    /// §31: the round was closed by `finish_review` — its `pending` files were left on disk unreviewed.
    public var finished = false
    /// §34.4 (wave2 contract): the round still in progress (`review_history.current`); `endedAt` = its last update.
    public var inProgress = false

    public init(id: String, sessionId: String? = nil, turns: [Int] = [], startedAt: String = "", endedAt: String = "", prompt: String = "",
                files: [ReviewHistoryFile] = [], notes: [ReviewHistoryNote] = [], turnStartTree: String = "", turnEndTree: String = "") {
        self.id = id
        self.sessionId = sessionId
        self.turns = turns
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.prompt = prompt
        self.files = files
        self.notes = notes
        self.turnStartTree = turnStartTree
        self.turnEndTree = turnEndTree
    }

    private enum CodingKeys: String, CodingKey { case id, sessionId, turns, startedAt, endedAt, prompt, files, notes, turnStartTree, turnEndTree, finished, inProgress }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(String.self, forKey: .id),
            sessionId: try c.decodeIfPresent(String.self, forKey: .sessionId),
            turns: try c.decodeIfPresent([Int].self, forKey: .turns) ?? [],
            startedAt: try c.decodeIfPresent(String.self, forKey: .startedAt) ?? "",
            endedAt: try c.decodeIfPresent(String.self, forKey: .endedAt) ?? "",
            prompt: try c.decodeIfPresent(String.self, forKey: .prompt) ?? "",
            files: try c.decodeIfPresent([ReviewHistoryFile].self, forKey: .files) ?? [],
            notes: try c.decodeIfPresent([ReviewHistoryNote].self, forKey: .notes) ?? [],
            turnStartTree: try c.decodeIfPresent(String.self, forKey: .turnStartTree) ?? "",
            turnEndTree: try c.decodeIfPresent(String.self, forKey: .turnEndTree) ?? "")
        // MARK: wave1 mac-review
        finished = (try? c.decodeIfPresent(Bool.self, forKey: .finished)) ?? false
        inProgress = lenientValue(Bool.self, c, .inProgress) ?? false   // wave2 contract
    }

    public var startedDate: Date? { isoDate(startedAt) }
    public var endedDate: Date? { isoDate(endedAt) ?? isoDate(startedAt) }

    /// How many files got each verdict, in `HistoryVerdict.allCases` order, zero counts left out (the list's chips).
    public var verdictCounts: [(verdict: HistoryVerdict, count: Int)] {
        HistoryVerdict.allCases.compactMap { v in
            let n = files.filter { $0.verdict == v }.count
            return n > 0 ? (v, n) : nil
        }
    }

    public var totalAdds: Int { files.reduce(0) { $0 + $1.adds } }
    public var totalDels: Int { files.reduce(0) { $0 + $1.dels } }
    public var rejectedHunks: Int { files.reduce(0) { $0 + $1.rejectedHunks } }

    /// The notes left on `path` (line notes in line order, whole-file notes first).
    public func notes(for path: String) -> [ReviewHistoryNote] {
        notes.enumerated().filter { $0.element.path == path }
            .sorted { ($0.element.line ?? -1, $0.offset) < ($1.element.line ?? -1, $1.offset) }
            .map(\.element)
    }
}

// MARK: - §15 Turn summary

/// `turn_summary`: what the turn changed and why, the commands it ran, and the approved plan mapped to the changes.
public struct TurnSummary: Sendable, Equatable {
    public struct File: Sendable, Equatable, Identifiable {
        public var id: String { path }
        public var path: String
        public var status: ChangeStatus
        public var state: FileReviewState
        public var adds: Int
        public var dels: Int
        /// Rationale (§12) of the first touching call that has one.
        public var why: String?
        public var whyToolUseId: String?
        public var tools: [String]
        public var toolUseIds: [String]
        // MARK: wave1 mac-review
        /// §31: who changed it (nil: an older engine / an unknown value).
        public var origin: FileOrigin?
        // MARK: wave2 contract — §34.3 / §34.8
        /// `why` with its source, age, agent and delegation (`why` / `whyToolUseId` mirror its text / call).
        public var whyDetail: FileWhy?
        /// The file's +/- over the whole review (A → B); `adds` / `dels` are this turn's.
        public var reviewAdds: Int?
        public var reviewDels: Int?
        // MARK: wave4b w4b-files — §40.2: the list's badges (nil on older engines)
        public var engineRisks: [String]?
        public var riskScore: Int?

        public init(path: String, status: ChangeStatus = .modified, state: FileReviewState = .pending, adds: Int = 0, dels: Int = 0,
                    why: String? = nil, whyToolUseId: String? = nil, tools: [String] = [], toolUseIds: [String] = []) {
            self.path = path
            self.status = status
            self.state = state
            self.adds = adds
            self.dels = dels
            self.why = why
            self.whyToolUseId = whyToolUseId
            self.tools = tools
            self.toolUseIds = toolUseIds
        }
    }

    public struct Command: Sendable, Equatable, Identifiable {
        public var id: String { toolUseId }
        public var toolUseId: String
        public var command: String
        public var isError: Bool
        public var testOutcome: TestOutcome?
        public var parentToolUseId: String?

        public init(toolUseId: String, command: String, isError: Bool = false, testOutcome: TestOutcome? = nil, parentToolUseId: String? = nil) {
            self.toolUseId = toolUseId
            self.command = command
            self.isError = isError
            self.testOutcome = testOutcome
            self.parentToolUseId = parentToolUseId
        }
    }

    public struct PlanStep: Sendable, Equatable, Identifiable {
        public var id: Int { index }
        public var index: Int
        public var text: String
        /// The plan's own checkbox (`- [x]`); nil for numbered items / headings.
        public var done: Bool?
        /// Changed files the step mentions.
        public var files: [String]

        public init(index: Int, text: String, done: Bool? = nil, files: [String] = []) {
            self.index = index
            self.text = text
            self.done = done
            self.files = files
        }
    }

    public struct Plan: Sendable, Equatable {
        /// The approved plan file (nil: ExitPlanMode only).
        public var path: String?
        public var steps: [PlanStep]
        /// Changed files no step mentions.
        public var unplannedFiles: [String]
        // MARK: wave4d w4d-plan
        /// §42.1: where the plan came from (nil: an older engine — the approved plan — or an unknown kind).
        public var source: PlanSourceKind?
        /// §42.1: the plan file's name or the request's first sentence.
        public var title: String?

        public init(path: String? = nil, steps: [PlanStep] = [], unplannedFiles: [String] = [], source: PlanSourceKind? = nil, title: String? = nil) {
            self.path = path
            self.steps = steps
            self.unplannedFiles = unplannedFiles
            self.source = source
            self.title = title
        }
    }

    public var turn: Int
    public var files: [File]
    public var commands: [Command]
    public var plan: Plan?
    // MARK: wave2 contract — §34.3 / §34.9
    /// Totals over the whole review list (`files` are the files THIS turn changed).
    public var review: ChangeTotals?
    /// The turn merged into a standing review (a question / request-changes follow-up).
    public var merged = false
    /// The turn's last recognized test run.
    public var lastTest: LastTest?
    // MARK: wave3 check-clients
    /// The engine sent `lastTest` — null means no test ran this turn; an engine before §34 sends no key (false).
    public var lastTestReported = false
    // MARK: wave4c w4c-trust
    /// §41.2: the files this collection's rules accepted ("규칙으로 수락 N개"); empty on older engines.
    public var autoAccepted: [AutoAcceptedFile] = []
    // MARK: wave4d w4d-agents2
    /// §42.4: what each model cost in the turn; empty on older engines / CLIs.
    public var models: [ModelCost] = []
    // MARK: wave5 w5-model
    /// §43.4: the model the turn was given ("모델: opus (자동 · 설계 판단)"); nil on older engines / when auto did not touch it.
    public var autoModel: AutoModelChoice?

    public init(turn: Int, files: [File] = [], commands: [Command] = [], plan: Plan? = nil) {
        self.turn = turn
        self.files = files
        self.commands = commands
        self.plan = plan
    }
}

extension TurnSummary.File: Decodable {
    private enum CodingKeys: String, CodingKey { case path, status, state, adds, dels, why, whyToolUseId, tools, toolUseIds, origin }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            path: try c.decode(String.self, forKey: .path),
            status: (try? c.decodeIfPresent(String.self, forKey: .status)).flatMap { $0.flatMap(ChangeStatus.init(rawValue:)) } ?? .other,
            state: FileReviewState(lenient: try? c.decodeIfPresent(String.self, forKey: .state)),
            adds: try c.decodeIfPresent(Int.self, forKey: .adds) ?? 0,
            dels: try c.decodeIfPresent(Int.self, forKey: .dels) ?? 0,
            why: try c.decodeIfPresent(String.self, forKey: .why),
            whyToolUseId: try c.decodeIfPresent(String.self, forKey: .whyToolUseId),
            tools: try c.decodeIfPresent([String].self, forKey: .tools) ?? [],
            toolUseIds: try c.decodeIfPresent([String].self, forKey: .toolUseIds) ?? [])
        // MARK: wave1 mac-review
        origin = FileOrigin(lenient: try? c.decodeIfPresent(String.self, forKey: .origin))
        // MARK: wave2 contract
        let round2 = TurnSummaryReviewFields.file(from: decoder)
        whyDetail = round2.whyDetail
        reviewAdds = round2.reviewAdds
        reviewDels = round2.reviewDels
        // MARK: wave4b w4b-files (§40.2)
        let list = FileListWire.changedFile(from: decoder)
        engineRisks = list.risks
        riskScore = list.riskScore
    }
}

extension TurnSummary.Command: Decodable {
    private enum CodingKeys: String, CodingKey { case toolUseId, command, isError, testOutcome, parentToolUseId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            toolUseId: try c.decodeIfPresent(String.self, forKey: .toolUseId) ?? "",
            command: try c.decodeIfPresent(String.self, forKey: .command) ?? "",
            isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false,
            testOutcome: try? c.decodeIfPresent(TestOutcome.self, forKey: .testOutcome),
            parentToolUseId: try c.decodeIfPresent(String.self, forKey: .parentToolUseId))
    }
}

extension TurnSummary.PlanStep: Decodable {
    private enum CodingKeys: String, CodingKey { case index, text, done, files }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(index: try c.decodeIfPresent(Int.self, forKey: .index) ?? 0,
                  text: try c.decodeIfPresent(String.self, forKey: .text) ?? "",
                  done: try c.decodeIfPresent(Bool.self, forKey: .done),
                  files: try c.decodeIfPresent([String].self, forKey: .files) ?? [])
    }
}

extension TurnSummary.Plan: Decodable {
    private enum CodingKeys: String, CodingKey { case path, steps, unplannedFiles, source, title }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(path: try c.decodeIfPresent(String.self, forKey: .path),
                  steps: try c.decodeIfPresent([TurnSummary.PlanStep].self, forKey: .steps) ?? [],
                  unplannedFiles: try c.decodeIfPresent([String].self, forKey: .unplannedFiles) ?? [],
                  // MARK: wave4d w4d-plan (§42.1, lenient)
                  source: (try? c.decodeIfPresent(String.self, forKey: .source)).flatMap { $0.flatMap(PlanSourceKind.init(rawValue:)) },
                  title: try? c.decodeIfPresent(String.self, forKey: .title))
    }
}

extension TurnSummary: Decodable {
    private enum CodingKeys: String, CodingKey { case turn, files, commands, plan }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(turn: try c.decodeIfPresent(Int.self, forKey: .turn) ?? 0,
                  files: try c.decodeIfPresent([File].self, forKey: .files) ?? [],
                  commands: try c.decodeIfPresent([Command].self, forKey: .commands) ?? [],
                  plan: try? c.decodeIfPresent(Plan.self, forKey: .plan))
        // MARK: wave2 contract
        let round2 = TurnSummaryReviewFields.summary(from: decoder)
        review = round2.review
        merged = round2.merged
        lastTest = round2.lastTest
        lastTestReported = Self.reportsLastTest(decoder)   // wave3 check-clients
        autoAccepted = TrustWire.summaryAutoAccepted(from: decoder)   // MARK: wave4c w4c-trust (§41.2)
        models = AgentCostWire.models(from: decoder)   // wave4d w4d-agents2 (§42.4)
        autoModel = AutoModelWire.choice(from: decoder)   // wave5 w5-model (§43.4)
    }
}

// MARK: - §16 User extensions

/// `capabilities.pluginDetails[]`: a plugin with its install path and `name@marketplace` id.
public struct PluginDetail: Codable, Sendable, Equatable {
    public var name: String
    public var path: String?
    public var id: String?
    public var version: String?

    public init(name: String, path: String? = nil, id: String? = nil, version: String? = nil) {
        self.name = name
        self.path = path
        self.id = id
        self.version = version
    }
}

/// A plugin of `SessionExtensions`: loaded (`enabled`) or turned off through `settings.disabledPlugins`.
public struct ExtensionPlugin: Codable, Sendable, Equatable {
    public var name: String
    /// `name@marketplace`; nil for `--plugin-dir` plugins (those cannot be disabled).
    public var id: String?
    public var path: String?
    public var version: String?
    public var enabled: Bool

    /// The value `settings.disabledPlugins` carries for this plugin.
    public var key: String { id ?? name }

    public init(name: String, id: String? = nil, path: String? = nil, version: String? = nil, enabled: Bool = true) {
        self.name = name
        self.id = id
        self.path = path
        self.version = version
        self.enabled = enabled
    }

    private enum CodingKeys: String, CodingKey { case name, id, path, version, enabled }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(name: try c.decodeIfPresent(String.self, forKey: .name) ?? "",
                  id: try c.decodeIfPresent(String.self, forKey: .id),
                  path: try c.decodeIfPresent(String.self, forKey: .path),
                  version: try c.decodeIfPresent(String.self, forKey: .version),
                  enabled: try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true)
    }
}

/// A hooks source besides ReviewGate's own.
public struct ExtensionHook: Codable, Sendable, Equatable {
    public enum Source: String, Codable, Sendable, CaseIterable { case user, project, plugin }

    public var source: Source
    public var plugin: String?
    public var path: String
    public var events: [String]
    public var active: Bool

    public init(source: Source, plugin: String? = nil, path: String, events: [String] = [], active: Bool = true) {
        self.source = source
        self.plugin = plugin
        self.path = path
        self.events = events
        self.active = active
    }

    private enum CodingKeys: String, CodingKey { case source, plugin, path, events, active }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(source: (try? c.decodeIfPresent(Source.self, forKey: .source)) ?? .user,
                  plugin: try c.decodeIfPresent(String.self, forKey: .plugin),
                  path: try c.decodeIfPresent(String.self, forKey: .path) ?? "",
                  events: try c.decodeIfPresent([String].self, forKey: .events) ?? [],
                  active: try c.decodeIfPresent(Bool.self, forKey: .active) ?? true)
    }
}

/// A CLAUDE.md / auto-memory file the CLI loaded.
public struct MemoryFile: Codable, Sendable, Equatable {
    public var path: String
    public var type: String
    public var tokens: Int?
    // MARK: wave4d w4d-config
    /// §42.3: what the file is (`InstructionKind` raw value); nil from older engines.
    public var kind: String? = nil
    /// §42.3: the app can save it (`claude_md_write`).
    public var editable: Bool? = nil

    public init(path: String, type: String, tokens: Int? = nil) {
        self.path = path
        self.type = type
        self.tokens = tokens
    }
}

public struct MCPServerStatus: Codable, Sendable, Equatable {
    public var name: String
    /// "connected" | "failed" | "needs-auth" | "pending" | …
    public var status: String

    public init(name: String, status: String) {
        self.name = name
        self.status = status
    }

    private enum CodingKeys: String, CodingKey { case name, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(name: try c.decodeIfPresent(String.self, forKey: .name) ?? "", status: try c.decodeIfPresent(String.self, forKey: .status) ?? "")
    }
}

/// `extensions.fallback` / `extensions_fallback`: the session was restarted without user settings.
public struct ExtensionsFallback: Codable, Sendable, Equatable {
    /// "init_timeout".
    public var reason: String
    public var timeoutMs: Int
    /// ISO-8601.
    public var at: String

    public init(reason: String = "init_timeout", timeoutMs: Int, at: String = "") {
        self.reason = reason
        self.timeoutMs = timeoutMs
        self.at = at
    }

    /// Whole seconds for the banner ("more than 20 s").
    public var timeoutSeconds: Int { max(1, Int((Double(timeoutMs) / 1000).rounded())) }

    private enum CodingKeys: String, CodingKey { case reason, timeoutMs, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "init_timeout",
                  timeoutMs: try c.decodeIfPresent(Int.self, forKey: .timeoutMs) ?? 0,
                  at: try c.decodeIfPresent(String.self, forKey: .at) ?? "")
    }
}

/// Which CLAUDE.md files took part; `source` "cli" (the CLI reported them) or "files" (file existence only).
public struct ClaudeMdInfo: Codable, Sendable, Equatable {
    public var user: Bool
    public var project: Bool
    public var source: String

    public init(user: Bool = false, project: Bool = false, source: String = "files") {
        self.user = user
        self.project = project
        self.source = source
    }

    private enum CodingKeys: String, CodingKey { case user, project, source }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(user: try c.decodeIfPresent(Bool.self, forKey: .user) ?? false,
                  project: try c.decodeIfPresent(Bool.self, forKey: .project) ?? false,
                  source: try c.decodeIfPresent(String.self, forKey: .source) ?? "files")
    }
}

/// `state.session.extensions` (§16): what the running session applied from the user's extensions.
public struct SessionExtensions: Codable, Sendable, Equatable {
    /// "user" / "project".
    public var settingSources: [String]
    public var fallback: ExtensionsFallback?
    public var plugins: [ExtensionPlugin]
    /// Ids passed as `enabledPlugins: {id: false}`.
    public var disabledPlugins: [String]
    /// `settings.disabledPlugins` bare names no known plugin matched (ignored).
    public var unresolvedDisabledPlugins: [String]
    public var userHooksDisabled: Bool
    public var skills: [String]
    public var slashCommands: [String]
    public var mcpServers: [MCPServerStatus]
    /// nil until the CLI reported them.
    public var memoryFiles: [MemoryFile]?
    public var claudeMd: ClaudeMdInfo
    public var hooks: [ExtensionHook]
    // MARK: wave3 mac-session
    /// §36.6: what the local settings hold that this session does not apply; nil when they apply / hold nothing.
    public var notApplied: NotAppliedLocalSettings?
    // MARK: wave4d w4d-config
    /// §42.3: the project's own instruction files the app can edit (existing or not); nil from older engines.
    public var projectInstructions: [ProjectInstructionFile]?
    /// §42.3: the subagents Claude can start; nil until the CLI answered (or from older engines).
    public var agents: [SubagentInfo]?
    // MARK: wave5 w5-graph
    /// §43.3: the user's Claude Code mods (read only); nil when there are none or from older engines.
    public var mods: [UserMod]?

    public init(settingSources: [String] = ["user", "project"], fallback: ExtensionsFallback? = nil, plugins: [ExtensionPlugin] = [],
                disabledPlugins: [String] = [], unresolvedDisabledPlugins: [String] = [], userHooksDisabled: Bool = false,
                skills: [String] = [], slashCommands: [String] = [], mcpServers: [MCPServerStatus] = [], memoryFiles: [MemoryFile]? = nil,
                claudeMd: ClaudeMdInfo = ClaudeMdInfo(), hooks: [ExtensionHook] = []) {
        self.settingSources = settingSources
        self.fallback = fallback
        self.plugins = plugins
        self.disabledPlugins = disabledPlugins
        self.unresolvedDisabledPlugins = unresolvedDisabledPlugins
        self.userHooksDisabled = userHooksDisabled
        self.skills = skills
        self.slashCommands = slashCommands
        self.mcpServers = mcpServers
        self.memoryFiles = memoryFiles
        self.claudeMd = claudeMd
        self.hooks = hooks
    }

    /// The user's settings (`~/.claude/settings.json`, plugins, MCP servers, hooks) took part.
    public var loadsUserSettings: Bool { settingSources.contains("user") }

    private enum CodingKeys: String, CodingKey {
        case settingSources, fallback, plugins, disabledPlugins, unresolvedDisabledPlugins, userHooksDisabled, skills, slashCommands
        case mcpServers, memoryFiles, claudeMd, hooks
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            settingSources: try c.decodeIfPresent([String].self, forKey: .settingSources) ?? [],
            fallback: try? c.decodeIfPresent(ExtensionsFallback.self, forKey: .fallback),
            plugins: try c.decodeIfPresent([ExtensionPlugin].self, forKey: .plugins) ?? [],
            disabledPlugins: try c.decodeIfPresent([String].self, forKey: .disabledPlugins) ?? [],
            unresolvedDisabledPlugins: try c.decodeIfPresent([String].self, forKey: .unresolvedDisabledPlugins) ?? [],
            userHooksDisabled: try c.decodeIfPresent(Bool.self, forKey: .userHooksDisabled) ?? false,
            skills: try c.decodeIfPresent([String].self, forKey: .skills) ?? [],
            slashCommands: try c.decodeIfPresent([String].self, forKey: .slashCommands) ?? [],
            mcpServers: try c.decodeIfPresent([MCPServerStatus].self, forKey: .mcpServers) ?? [],
            memoryFiles: try? c.decodeIfPresent([MemoryFile].self, forKey: .memoryFiles),
            claudeMd: (try? c.decodeIfPresent(ClaudeMdInfo.self, forKey: .claudeMd)) ?? ClaudeMdInfo(),
            hooks: (try? c.decodeIfPresent([ExtensionHook].self, forKey: .hooks)) ?? [])
        decodeLocalFields(from: decoder)   // wave3 mac-session: notApplied
        decodeInstructionFields(from: decoder)   // wave4d w4d-config: projectInstructions, agents
        decodeModFields(from: decoder)   // MARK: wave5 w5-graph: mods
    }
}
