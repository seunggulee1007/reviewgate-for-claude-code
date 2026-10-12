import Foundation

// MARK: wave3 mac-flow
// docs/PROTOCOL.md §36.11–36.14 on the wire (TypeScript: the §36 block of engine/src/protocol.ts): the commit message draft
// (`commit_draft`, `settings.commitTemplate`), the workbench setup (`settings.workbenchSetup`, `workbench_preview`, the new
// `workbench_create` fields, `workbench_progress`, `branches.remotes`), the AI pre-review (`prereview_*`, the `prereview`
// event, `gate.prereviews`) and the PR anchor of a side question (`SideAnchor.pr`). Every field is optional and read
// leniently: an engine before §36 sends none of them (and refuses the new commands `unknown_command`), and the screens
// behave as before. A reply never fails to decode — a request waiting for it would wait forever.

// MARK: - §36.11 Commit message draft

/// Reply to `commit_draft`: a message for the commit sheet's field (nothing is committed).
public struct CommitDraftReply: Sendable, Equatable {
    public var id: String?
    public var message: String

    public init(id: String? = nil, message: String) {
        self.id = id
        self.message = message
    }
}

extension CommitDraftReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, message }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), message: lenientValue(String.self, c, .message) ?? "")
    }
}

// MARK: - §36.12 Workbench setup

/// Where a new workbench goes: under `settings.worktreeRoot` (`managed`) or next to the main worktree as
/// `<repo>-<branch tail>` (`sibling`).
public enum WorkbenchLocation: String, Codable, Sendable, CaseIterable, Identifiable {
    case managed, sibling

    public var id: String { rawValue }
}

/// `settings.workbenchSetup` — how `workbench_create` prepares a new workbench (kept per project in the app).
public struct WorkbenchSetup: Codable, Sendable, Equatable {
    /// Globs (repo-relative, `*` / `**` / `?`) of untracked or ignored files copied from this worktree.
    public var copy: [String]
    /// Also copy what `<root>/.worktreeinclude` lists.
    public var useWorktreeInclude: Bool
    /// Run in the new worktree after the copy (the user's login shell); "" = none.
    public var setupCommand: String
    /// Fetch a remote base before creating.
    public var fetchBase: Bool
    public var location: WorkbenchLocation

    public init(copy: [String] = [], useWorktreeInclude: Bool = true, setupCommand: String = "", fetchBase: Bool = true,
                location: WorkbenchLocation = .managed) {
        self.copy = copy
        self.useWorktreeInclude = useWorktreeInclude
        self.setupCommand = setupCommand
        self.fetchBase = fetchBase
        self.location = location
    }

    public static let `default` = WorkbenchSetup()

    /// The setup command without surrounding whitespace; nil when there is none.
    public var command: String? {
        let trimmed = setupCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private enum CodingKeys: String, CodingKey { case copy, useWorktreeInclude, setupCommand, fetchBase, location }

    /// Lenient (a stored value of an older shape never resets the others).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(copy: lenientValue([String].self, c, .copy) ?? [],
                  useWorktreeInclude: lenientValue(Bool.self, c, .useWorktreeInclude) ?? true,
                  setupCommand: lenientValue(String.self, c, .setupCommand) ?? "",
                  fetchBase: lenientValue(Bool.self, c, .fetchBase) ?? true,
                  location: lenientValue(String.self, c, .location).flatMap(WorkbenchLocation.init(rawValue:)) ?? .managed)
    }

    /// Every field: `set_settings` replaces the whole object.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(copy, forKey: .copy)
        try c.encode(useWorktreeInclude, forKey: .useWorktreeInclude)
        try c.encode(setupCommand, forKey: .setupCommand)
        try c.encode(fetchBase, forKey: .fetchBase)
        try c.encode(location, forKey: .location)
    }
}

/// §36.14 `workbench_create.fromPr`: check out the PR's head (`refs/pull/<number>/head`).
public struct WorkbenchFromPr: Codable, Sendable, Hashable {
    public var number: Int
    public var headRef: String

    public init(number: Int, headRef: String) {
        self.number = number
        self.headRef = headRef
    }
}

/// The §36.12 / §36.14 fields of `workbench_create`; nil = the engine's default (`fetch` = `fetchBase`, `setup` = true,
/// `location` = the setting's).
public struct WorkbenchCreateOptions: Encodable, Sendable, Equatable {
    public var fetch: Bool?
    public var setup: Bool?
    public var location: WorkbenchLocation?
    public var fromPr: WorkbenchFromPr?

    public init(fetch: Bool? = nil, setup: Bool? = nil, location: WorkbenchLocation? = nil, fromPr: WorkbenchFromPr? = nil) {
        self.fetch = fetch
        self.setup = setup
        self.location = location
        self.fromPr = fromPr
    }

    private enum CodingKeys: String, CodingKey { case fetch, setup, location, fromPr }

    /// Next to the command's own fields (same keyed container of the envelope).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(fetch, forKey: .fetch)
        try c.encodeIfPresent(setup, forKey: .setup)
        try c.encodeIfPresent(location, forKey: .location)
        try c.encodeIfPresent(fromPr, forKey: .fromPr)
    }
}

/// One file `workbench_create` would copy.
public struct WorkbenchCopyItem: Codable, Sendable, Hashable, Identifiable {
    public var path: String
    public var bytes: Int

    public var id: String { path }

    public init(path: String, bytes: Int) {
        self.path = path
        self.bytes = bytes
    }

    private enum CodingKeys: String, CodingKey { case path, bytes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let path = lenientValue(String.self, c, .path) ?? ""
        guard !path.isEmpty else { throw DecodingError.dataCorruptedError(forKey: .path, in: c, debugDescription: "A copy entry without a path") }
        self.init(path: path, bytes: lenientValue(Int.self, c, .bytes) ?? 0)
    }
}

/// Reply to `workbench_preview`: where the workbench would go and what would be copied (at most 500 entries — `truncated`;
/// `totalBytes` counts every file).
public struct WorkbenchPreviewReply: Sendable, Equatable {
    public var id: String?
    public var path: String
    public var copy: [WorkbenchCopyItem]
    public var totalBytes: Int
    /// Every file the create would copy — `copy` lists at most 500 (an older engine's reply: the list's length).
    public var count: Int
    public var truncated: Bool

    public init(id: String? = nil, path: String, copy: [WorkbenchCopyItem] = [], totalBytes: Int = 0, count: Int? = nil,
                truncated: Bool = false) {
        self.id = id
        self.path = path
        self.copy = copy
        self.totalBytes = totalBytes
        self.count = max(count ?? copy.count, copy.count)
        self.truncated = truncated
    }
}

extension WorkbenchPreviewReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, path, copy, totalBytes, count, truncated }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let copy = lenientElements(WorkbenchCopyItem.self, c, .copy)
        self.init(id: lenientValue(String.self, c, .id),
                  path: lenientValue(String.self, c, .path) ?? "",
                  copy: copy,
                  totalBytes: lenientValue(Int.self, c, .totalBytes) ?? copy.reduce(0) { $0 + $1.bytes },
                  count: lenientValue(Int.self, c, .count),
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false)
    }
}

/// The steps of `workbench_create`, in order.
public enum WorkbenchStep: String, Codable, Sendable, CaseIterable, Comparable {
    case fetch, create, copy, setup, done

    public static func < (lhs: WorkbenchStep, rhs: WorkbenchStep) -> Bool {
        allCases.firstIndex(of: lhs)! < allCases.firstIndex(of: rhs)!
    }
}

/// How a step's process ended: no exit code for that step, a code, or killed / timed out (`exitCode: null`).
public enum WorkbenchExit: Sendable, Equatable {
    case none
    case code(Int)
    case killed

    /// The step's process failed (a non-zero code, killed / timed out).
    public var failed: Bool {
        switch self {
        case .none: false
        case let .code(code): code != 0
        case .killed: true
        }
    }
}

/// `workbench_progress`: one step of a `workbench_create`, keyed by the new worktree's `path` (an event's `id` is a
/// reply id). `logTail`: the step's last ≤ 4 000 chars of output.
public struct WorkbenchProgress: Sendable, Equatable {
    public var path: String
    public var branch: String
    public var step: WorkbenchStep
    public var logTail: String?
    public var exit: WorkbenchExit

    public init(path: String, branch: String, step: WorkbenchStep, logTail: String? = nil, exit: WorkbenchExit = .none) {
        self.path = path
        self.branch = branch
        self.step = step
        self.logTail = logTail
        self.exit = exit
    }
}

extension WorkbenchProgress: Decodable {
    private enum CodingKeys: String, CodingKey { case path, branch, step, logTail, exitCode }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = lenientValue(String.self, c, .step) ?? ""
        guard let step = WorkbenchStep(rawValue: raw) else {
            throw DecodingError.dataCorruptedError(forKey: .step, in: c, debugDescription: "Unknown workbench step \(raw)")
        }
        let exit: WorkbenchExit
        if !c.contains(.exitCode) {
            exit = .none
        } else if (try? c.decodeNil(forKey: .exitCode)) == true {
            exit = .killed
        } else {
            exit = lenientValue(Int.self, c, .exitCode).map(WorkbenchExit.code) ?? .none
        }
        self.init(path: lenientValue(String.self, c, .path) ?? "", branch: lenientValue(String.self, c, .branch) ?? "",
                  step: step, logTail: lenientValue(String.self, c, .logTail), exit: exit)
    }
}

/// `state.branches.remotes`: remote-tracking branches (`origin/develop`) as bases for `workbench_create` — never offered
/// for switching. Decoded element by element (one odd entry never fails the snapshot); nil from engines before §36.12.
public struct RemoteBranchList: Codable, Sendable, Equatable {
    public var branches: [BranchInfo]

    public init(_ branches: [BranchInfo]) { self.branches = branches }

    public init(from decoder: Decoder) throws {
        var out: [BranchInfo] = []
        if var list = try? decoder.unkeyedContainer() {
            while !list.isAtEnd {
                if let item = try? list.decode(BranchInfo.self) {
                    out.append(item)
                } else if (try? list.decode(JSONValue.self)) == nil {
                    break
                }
            }
        }
        branches = out
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(branches)
    }
}

// MARK: - §36.13 AI pre-review

public enum PreReviewScope: String, Codable, Sendable { case round, files }

public enum PreReviewEffort: String, Codable, Sendable, CaseIterable, Identifiable {
    case low, medium, high

    public var id: String { rawValue }

    /// The effort picker's words (the model effort's: 낮음 / 보통 / 높음).
    public var title: String {
        switch self {
        case .low: String(localized: "Low", bundle: .module)
        case .medium: String(localized: "Medium", bundle: .module)
        case .high: String(localized: "High", bundle: .module)
        }
    }
}

public enum PreReviewStatus: String, Codable, Sendable { case running, done, failed, cancelled }

/// `round`: `prereview_start`; `main`: the main chat's own ReportFindings call (`prereviewId` = its tool_use id).
public enum PreReviewSource: String, Codable, Sendable { case round, main }

/// One finding of a ReportFindings call: `file` repo-relative, `line` on the new side (nil: the whole file).
public struct PreReviewFinding: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var file: String
    public var line: Int?
    public var summary: String
    public var shortSummary: String
    public var failureScenario: String
    public var category: String?

    public init(id: String, file: String, line: Int? = nil, summary: String, shortSummary: String = "", failureScenario: String = "",
                category: String? = nil) {
        self.id = id
        self.file = file
        self.line = line
        self.summary = summary
        self.shortSummary = shortSummary
        self.failureScenario = failureScenario
        self.category = category
    }

    private enum CodingKeys: String, CodingKey { case id, file, line, summary, shortSummary, failureScenario, category }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = lenientValue(String.self, c, .id) ?? "", file = lenientValue(String.self, c, .file) ?? ""
        guard !id.isEmpty, !file.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "A finding without id or file")
        }
        let line = lenientValue(Int.self, c, .line)
        self.init(id: id, file: file, line: line.flatMap { $0 > 0 ? $0 : nil },
                  summary: lenientValue(String.self, c, .summary) ?? "",
                  shortSummary: lenientValue(String.self, c, .shortSummary) ?? "",
                  failureScenario: lenientValue(String.self, c, .failureScenario) ?? "",
                  category: lenientValue(String.self, c, .category).flatMap { $0.isEmpty ? nil : $0 })
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(file, forKey: .file)
        try c.encode(line, forKey: .line)
        try c.encode(summary, forKey: .summary)
        try c.encode(shortSummary, forKey: .shortSummary)
        try c.encode(failureScenario, forKey: .failureScenario)
        try c.encodeIfPresent(category, forKey: .category)
    }
}

/// One pre-review (`state.gate.prereviews[]`, the `prereview` event).
public struct PreReviewRun: Codable, Sendable, Equatable, Identifiable {
    public var prereviewId: String
    public var status: PreReviewStatus
    public var source: PreReviewSource
    public var scope: PreReviewScope?
    public var paths: [String]?
    public var effort: PreReviewEffort?
    /// The B the findings' lines refer to (`gate.reviewEndTree` when it ran).
    public var endTree: String?
    /// ISO-8601
    public var startedAt: String
    public var endedAt: String?
    /// Dismissed findings are removed by the engine.
    public var findings: [PreReviewFinding]
    /// `failed`: why (English; refusal-style code words).
    public var error: String?
    public var costUSD: Double?

    public var id: String { prereviewId }

    public init(prereviewId: String, status: PreReviewStatus, source: PreReviewSource = .round, scope: PreReviewScope? = nil,
                paths: [String]? = nil, effort: PreReviewEffort? = nil, endTree: String? = nil, startedAt: String = "",
                endedAt: String? = nil, findings: [PreReviewFinding] = [], error: String? = nil, costUSD: Double? = nil) {
        self.prereviewId = prereviewId
        self.status = status
        self.source = source
        self.scope = scope
        self.paths = paths
        self.effort = effort
        self.endTree = endTree
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.findings = findings
        self.error = error
        self.costUSD = costUSD
    }

    private enum CodingKeys: String, CodingKey {
        case prereviewId, status, source, scope, paths, effort, endTree, startedAt, endedAt, findings, error, costUSD
    }

    /// Lenient: an unknown status reads as running until the run has an end, done after; an unknown source as `round`.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let endedAt = lenientValue(String.self, c, .endedAt)
        let status = lenientValue(String.self, c, .status).flatMap(PreReviewStatus.init(rawValue:)) ?? (endedAt == nil ? .running : .done)
        self.init(prereviewId: lenientValue(String.self, c, .prereviewId) ?? "",
                  status: status,
                  source: lenientValue(String.self, c, .source).flatMap(PreReviewSource.init(rawValue:)) ?? .round,
                  scope: lenientValue(String.self, c, .scope).flatMap(PreReviewScope.init(rawValue:)),
                  paths: lenientValue([String].self, c, .paths),
                  effort: lenientValue(String.self, c, .effort).flatMap(PreReviewEffort.init(rawValue:)),
                  endTree: lenientValue(String.self, c, .endTree),
                  startedAt: lenientValue(String.self, c, .startedAt) ?? "",
                  endedAt: endedAt,
                  findings: lenientElements(PreReviewFinding.self, c, .findings),
                  error: lenientValue(String.self, c, .error),
                  costUSD: lenientValue(Double.self, c, .costUSD))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(prereviewId, forKey: .prereviewId)
        try c.encode(status, forKey: .status)
        try c.encode(source, forKey: .source)
        try c.encodeIfPresent(scope, forKey: .scope)
        try c.encodeIfPresent(paths, forKey: .paths)
        try c.encodeIfPresent(effort, forKey: .effort)
        try c.encode(endTree, forKey: .endTree)
        try c.encode(startedAt, forKey: .startedAt)
        try c.encodeIfPresent(endedAt, forKey: .endedAt)
        try c.encode(findings, forKey: .findings)
        try c.encodeIfPresent(error, forKey: .error)
        try c.encodeIfPresent(costUSD, forKey: .costUSD)
    }

}

/// The `prereview` event: a pre-review started, progressed or ended (also the reply to `prereview_start`).
public struct PreReviewReply: Sendable, Equatable {
    public var id: String?
    public var run: PreReviewRun

    public init(id: String? = nil, run: PreReviewRun) {
        self.id = id
        self.run = run
    }
}

extension PreReviewReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), run: try PreReviewRun(from: decoder))
    }
}

extension GateInfo {
    private enum PreReviewKeys: String, CodingKey { case prereviews }

    /// `gate.prereviews` element by element (one odd run never hides the rest); empty on engines before §36.13.
    static func decodePreReviews(from decoder: Decoder) -> [PreReviewRun] {
        guard let c = try? decoder.container(keyedBy: PreReviewKeys.self) else { return [] }
        return lenientElements(PreReviewRun.self, c, .prereviews).filter { !$0.prereviewId.isEmpty }
    }
}

// MARK: - §36.14 PR anchor of a side question

/// `SideAnchor.pr`: a line / hunk of the PR open in the PR tab. The side prompt gets `PR #<number> <path>:<line> (<side>)`
/// and the hunk, quoted as data.
public struct SidePrAnchor: Codable, Sendable, Hashable {
    public var number: Int
    public var path: String
    public var line: Int?
    /// `LEFT` / `RIGHT`
    public var side: String
    /// The hunk's text (≤ 4 000 chars; the engine cuts longer).
    public var hunk: String
    public var commitId: String?

    public static let maxHunkChars = 4_000

    public init(number: Int, path: String, line: Int?, side: String, hunk: String, commitId: String? = nil) {
        self.number = number
        self.path = path
        self.line = line
        self.side = side
        self.hunk = hunk
        self.commitId = commitId
    }

    private enum CodingKeys: String, CodingKey { case number, path, line, side, hunk, commitId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(number: lenientValue(Int.self, c, .number) ?? 0, path: lenientValue(String.self, c, .path) ?? "",
                  line: lenientValue(Int.self, c, .line), side: lenientValue(String.self, c, .side) ?? "RIGHT",
                  hunk: lenientValue(String.self, c, .hunk) ?? "", commitId: lenientValue(String.self, c, .commitId))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(number, forKey: .number)
        try c.encode(path, forKey: .path)
        try c.encode(line, forKey: .line)   // explicit null: the whole hunk
        try c.encode(side, forKey: .side)
        try c.encode(hunk, forKey: .hunk)
        try c.encodeIfPresent(commitId, forKey: .commitId)
    }
}

extension SideAnchor {
    private enum PrKeys: String, CodingKey { case pr }

    /// A side question on a PR line / hunk (the review-anchor fields stay empty: the engine ignores them then).
    public init(pr: SidePrAnchor) {
        self.init()
        self.pr = pr
    }

    /// Called at the end of `init(from:)`.
    mutating func decodePrField(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: PrKeys.self) else { return }
        pr = lenientValue(SidePrAnchor.self, c, .pr).flatMap { $0.number > 0 && !$0.path.isEmpty ? $0 : nil }
    }

    /// Called at the end of `encode(to:)`.
    func encodePrField(to encoder: Encoder) throws {
        guard let pr else { return }
        var c = encoder.container(keyedBy: PrKeys.self)
        try c.encode(pr, forKey: .pr)
    }
}

// MARK: - Commands (§36.11–36.13)

extension EngineCommand {
    private enum FlowKeys: String, CodingKey { case paths, branch, from, location, scope, effort, prereviewId, findingId }

    /// The payload of the wave 3 flow commands (called from `encode(to:)` after `type`).
    func encodeFlowFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: FlowKeys.self)
        switch self {
        case let .commitDraft(paths):
            try c.encodeIfPresent(paths, forKey: .paths)
        case let .workbenchPreview(branch, from, location):
            try c.encode(branch, forKey: .branch)
            try c.encodeIfPresent(from, forKey: .from)
            try c.encodeIfPresent(location, forKey: .location)
        case let .prereviewStart(scope, paths, effort):
            try c.encode(scope, forKey: .scope)
            try c.encodeIfPresent(paths, forKey: .paths)
            try c.encode(effort, forKey: .effort)
        case let .prereviewCancel(prereviewId):
            try c.encode(prereviewId, forKey: .prereviewId)
        case let .prereviewDismiss(prereviewId, findingId):
            try c.encode(prereviewId, forKey: .prereviewId)
            try c.encode(findingId, forKey: .findingId)
        default:
            break
        }
    }
}
