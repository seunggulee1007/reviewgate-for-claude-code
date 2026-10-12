import Foundation

// Wire types of docs/PROTOCOL.md §34 (engine/src/protocol.ts) — review round 2: reviewing while Claude works, this turn /
// since the request / since the accept deltas, notes that survive a change request, viewed-by-content, live changes,
// in-line change segments, generated files, a sourced "why" and the last test verdict. Every field is optional on the
// wire and every decoder is lenient — a missing key defaults, an unknown value becomes `.other` / nil or is dropped — so
// a newer engine never makes a snapshot or an event undecodable, and an older one simply leaves these empty.

// MARK: - §34.1 Ranges

/// `select_file.since` / `full_file.since` / `file_diff.since`: which part of a file's change a diff shows. The new side is
/// always the review's B (`gate.reviewEndTree`); the old side is A (`review`), the last collected turn's own start
/// (`turn`, "이번 턴"), B when the last request_changes went out (`request`, "요청 이후") or B when the file was accepted
/// (`accepted`, "수락 이후").
public enum DiffSince: String, Sendable, Hashable, CaseIterable, Codable {
    case review, turn, request, accepted

    /// nil for a missing or unknown value (read as `review`).
    public init?(lenient raw: String?) {
        guard let raw, let since = DiffSince(rawValue: raw) else { return nil }
        self = since
    }
}

/// A count of changed files with their added / deleted lines (`turn_end.review`, `turn_summary.review`).
public struct ChangeTotals: Codable, Sendable, Hashable {
    public var files: Int
    public var added: Int
    public var deleted: Int

    public init(files: Int = 0, added: Int = 0, deleted: Int = 0) {
        self.files = files
        self.added = added
        self.deleted = deleted
    }

    private enum CodingKeys: String, CodingKey { case files, added, deleted }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(files: lenientValue(Int.self, c, .files) ?? 0, added: lenientValue(Int.self, c, .added) ?? 0,
                  deleted: lenientValue(Int.self, c, .deleted) ?? 0)
    }
}

/// `state.gate.lastTurnChanges`: what the last collected turn itself changed (its own start tree → B).
public struct LastTurnChanges: Codable, Sendable, Hashable {
    public var turn: Int
    public var files: Int
    public var added: Int
    public var deleted: Int

    public init(turn: Int, files: Int = 0, added: Int = 0, deleted: Int = 0) {
        self.turn = turn
        self.files = files
        self.added = added
        self.deleted = deleted
    }

    private enum CodingKeys: String, CodingKey { case turn, files, added, deleted }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(turn: lenientValue(Int.self, c, .turn) ?? 0, files: lenientValue(Int.self, c, .files) ?? 0,
                  added: lenientValue(Int.self, c, .added) ?? 0, deleted: lenientValue(Int.self, c, .deleted) ?? 0)
    }
}

/// `state.gate.lastRequest`: the last request_changes of the review in progress (`turn`: its follow-up turn).
public struct ReviewRequestInfo: Codable, Sendable, Hashable {
    public var turn: Int
    /// ISO-8601.
    public var at: String
    /// Notes it sent.
    public var notes: Int

    public init(turn: Int, at: String = "", notes: Int = 0) {
        self.turn = turn
        self.at = at
        self.notes = notes
    }

    private enum CodingKeys: String, CodingKey { case turn, at, notes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(turn: lenientValue(Int.self, c, .turn) ?? 0, at: lenientValue(String.self, c, .at) ?? "",
                  notes: lenientValue(Int.self, c, .notes) ?? 0)
    }
}

// MARK: - §34.7 Generated files, segments

/// `changedFiles[].generated` / `live_changes.files[].generated`: why the file is folded by default. Unknown values are
/// kept as `.other` (still folded).
public enum GeneratedKind: Sendable, Hashable {
    case lockfile
    /// `linguist-generated` / `-diff` in .gitattributes, or an `@generated` / "DO NOT EDIT" marker.
    case generated
    case minified
    case other(String)

    public init(raw: String) {
        switch raw {
        case "lockfile": self = .lockfile
        case "generated": self = .generated
        case "minified": self = .minified
        default: self = .other(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .lockfile: "lockfile"
        case .generated: "generated"
        case .minified: "minified"
        case let .other(raw): raw
        }
    }
}

/// One changed part of a diff line's `text`: `[start, end)` in UTF-16 code units — JS string indices, the same numbers as
/// Swift's `String.utf16` offsets. The engine never splits a code point.
public struct DiffSegment: Sendable, Hashable {
    public let start: Int
    public let end: Int

    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }

    /// The segment as a range of `text`; nil when it does not fit (a segment computed for another text).
    public func range(in text: String) -> Range<String.Index>? {
        let utf16 = text.utf16
        guard start >= 0, start <= end, end <= utf16.count,
              let lower = utf16.index(utf16.startIndex, offsetBy: start, limitedBy: utf16.endIndex),
              let upper = utf16.index(utf16.startIndex, offsetBy: end, limitedBy: utf16.endIndex) else { return nil }
        return lower..<upper
    }

    /// `[[start, end], …]` from the wire; malformed pairs (not two ints, start > end, negative) are dropped.
    static func list(_ raw: [[Int]]?) -> [DiffSegment] {
        (raw ?? []).compactMap { pair in
            guard pair.count == 2, pair[0] >= 0, pair[0] <= pair[1] else { return nil }
            return DiffSegment(start: pair[0], end: pair[1])
        }
    }
}

// MARK: - §34.8 Why

/// `tool_use.rationaleSource`: the text came from the call's own API message, or from the same agent's earlier text.
public enum RationaleSource: Sendable, Hashable {
    case sameMessage
    case earlier
    case other(String)

    public init(raw: String) {
        switch raw {
        case "same_message": self = .sameMessage
        case "earlier": self = .earlier
        default: self = .other(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .sameMessage: "same_message"
        case .earlier: "earlier"
        case let .other(raw): raw
        }
    }
}

/// Where a file's `why` came from: the turn-end report naming the file, the call's own message, an earlier text, or
/// nothing at all ("원인 기록 없음").
public enum WhySource: Sendable, Hashable {
    case reported
    case sameMessage
    case earlier
    /// Wire `"none"` ("원인 기록 없음"); not named `none` so `why?.source == .none` can never mean nil.
    case noRecord
    case other(String)

    public init(raw: String) {
        switch raw {
        case "reported": self = .reported
        case "same_message": self = .sameMessage
        case "earlier": self = .earlier
        case "none": self = .noRecord
        default: self = .other(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .reported: "reported"
        case .sameMessage: "same_message"
        case .earlier: "earlier"
        case .noRecord: "none"
        case let .other(raw): raw
        }
    }
}

/// The subagent whose text a `why` is: the spawning Agent call and its `subagent_type`.
public struct WhyAgent: Sendable, Hashable {
    public var toolUseId: String
    public var subagentType: String?

    public init(toolUseId: String, subagentType: String? = nil) {
        self.toolUseId = toolUseId
        self.subagentType = subagentType
    }
}

/// `changedFiles[].why` / `turn_summary.files[].whyDetail`: the engine's best explanation of a file's change.
public struct FileWhy: Sendable, Hashable, Decodable {
    /// nil with `source == .noRecord`.
    public var text: String?
    public var source: WhySource
    /// `.earlier`: tool calls of the same agent between the text and the change.
    public var age: Int?
    /// `.sameMessage` / `.earlier`: the call whose rationale it is.
    public var toolUseId: String?
    /// The text is a subagent's (its own text before the call, or its report).
    public var agent: WhyAgent?
    /// The change ran inside a subagent: the main agent's text before that Agent call ("위임 이유").
    public var delegation: String?
    /// The transcript turn the text belongs to.
    public var turn: Int?

    public init(text: String?, source: WhySource, age: Int? = nil, toolUseId: String? = nil, agent: WhyAgent? = nil,
                delegation: String? = nil, turn: Int? = nil) {
        self.text = text
        self.source = source
        self.age = age
        self.toolUseId = toolUseId
        self.agent = agent
        self.delegation = delegation
        self.turn = turn
    }

    private enum CodingKeys: String, CodingKey { case text, source, age, toolUseId, agent, delegation, turn }
    private enum AgentKeys: String, CodingKey { case toolUseId, subagentType }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var agent: WhyAgent?
        if let a = try? c.nestedContainer(keyedBy: AgentKeys.self, forKey: .agent),
           let id = (try? a.decodeIfPresent(String.self, forKey: .toolUseId)) ?? nil {
            agent = WhyAgent(toolUseId: id, subagentType: (try? a.decodeIfPresent(String.self, forKey: .subagentType)) ?? nil)
        }
        let text = lenientValue(String.self, c, .text)
        // A missing source reads as "none" without text, else as an unknown source (still shown).
        let source = lenientValue(String.self, c, .source).map(WhySource.init(raw:)) ?? (text == nil ? .noRecord : .other(""))
        self.init(text: text, source: source, age: lenientValue(Int.self, c, .age), toolUseId: lenientValue(String.self, c, .toolUseId),
                  agent: agent, delegation: lenientValue(String.self, c, .delegation), turn: lenientValue(Int.self, c, .turn))
    }
}

// MARK: - §34.9 Tests

/// `turn_summary.lastTest`: the turn's last recognized test run, in execution order.
public struct LastTest: Sendable, Hashable, Decodable {
    /// nil for an unknown verdict.
    public var verdict: TestOutcome?
    public var command: String
    public var toolUseId: String
    /// ISO-8601: when its tool_result arrived.
    public var at: String
    /// It ran after the turn's last file change: "마지막 편집 이후 실행됨"; false: "편집 뒤 테스트 없음".
    public var afterLastEdit: Bool
    /// Recognized test runs in the turn (this one included).
    public var runs: Int

    public init(verdict: TestOutcome?, command: String, toolUseId: String = "", at: String = "", afterLastEdit: Bool, runs: Int = 1) {
        self.verdict = verdict
        self.command = command
        self.toolUseId = toolUseId
        self.at = at
        self.afterLastEdit = afterLastEdit
        self.runs = runs
    }

    private enum CodingKeys: String, CodingKey { case verdict, command, toolUseId, at, afterLastEdit, runs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(verdict: lenientValue(String.self, c, .verdict).flatMap(TestOutcome.init(rawValue:)),
                  command: lenientValue(String.self, c, .command) ?? "", toolUseId: lenientValue(String.self, c, .toolUseId) ?? "",
                  at: lenientValue(String.self, c, .at) ?? "", afterLastEdit: lenientValue(Bool.self, c, .afterLastEdit) ?? false,
                  runs: lenientValue(Int.self, c, .runs) ?? 1)
    }
}

// MARK: - §34.4 Notes

/// `reviewNotes[].anchor`: what happened to a note's line after the file changed again.
public enum NoteAnchor: Sendable, Hashable, Codable {
    /// The line moved; `line` is its new number.
    case moved
    /// The line no longer exists ("위치 사라짐"); `line` keeps its last number.
    case gone
    case other(String)

    public init(raw: String) {
        switch raw {
        case "moved": self = .moved
        case "gone": self = .gone
        default: self = .other(raw)
        }
    }

    public var rawValue: String {
        switch self {
        case .moved: "moved"
        case .gone: "gone"
        case let .other(raw): raw
        }
    }

    public init(from decoder: Decoder) throws { self.init(raw: try decoder.singleValueContainer().decode(String.self)) }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// `reviewNotes[].sent`: the note went to Claude with request_changes (`turn`: the follow-up turn).
public struct NoteSent: Codable, Sendable, Hashable {
    /// ISO-8601.
    public var at: String
    public var turn: Int

    public init(at: String, turn: Int) {
        self.at = at
        self.turn = turn
    }

    private enum CodingKeys: String, CodingKey { case at, turn }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(at: lenientValue(String.self, c, .at) ?? "", turn: lenientValue(Int.self, c, .turn) ?? 0)
    }
}

// MARK: - §34.2 file_diff / turn_end extras

/// The §34 fields of a `file_diff` (empty on older engines and for `pr` diffs).
public struct FileDiffInfo: Sendable, Equatable {
    /// The range shown (nil = `review`, A → B).
    public var since: DiffSince?
    /// The old side's tree (A for `review`): what `reject_hunks.expectedBaseTree` echoes. Hunk ids of any other range are
    /// not valid for `reject_hunks`.
    public var baseTree: String?
    /// Served while a turn runs, on the held B: read-only until the collection.
    public var stale: Bool
    // MARK: wave4c w4c-review
    /// §41.3: a `select_file {ignoreWhitespace}` reply — the `-w` diff (read-only: no part revert, no hunk side question).
    public var ignoreWhitespace = false

    public init(since: DiffSince? = nil, baseTree: String? = nil, stale: Bool = false) {
        self.since = since
        self.baseTree = baseTree
        self.stale = stale
    }

    private enum CodingKeys: String, CodingKey { case since, baseTree, stale, ignoreWhitespace }

    static func lenient(from decoder: Decoder) -> FileDiffInfo {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return FileDiffInfo() }
        var info = FileDiffInfo(since: DiffSince(lenient: lenientValue(String.self, c, .since)), baseTree: lenientValue(String.self, c, .baseTree),
                                stale: lenientValue(Bool.self, c, .stale) ?? false)
        info.ignoreWhitespace = lenientValue(Bool.self, c, .ignoreWhitespace) ?? false   // wave4c w4c-review
        return info
    }
}

/// The §34.3 fields of `turn_end` (event and transcript row): `files` / `added` / `deleted` count THIS turn's changes;
/// `review` totals the whole review list; `merged`: the turn merged into a standing review.
public struct TurnEndReview: Sendable, Equatable {
    public var review: ChangeTotals?
    public var merged: Bool

    public init(review: ChangeTotals? = nil, merged: Bool = false) {
        self.review = review
        self.merged = merged
    }

    private enum CodingKeys: String, CodingKey { case review, merged }

    static func lenient(from decoder: Decoder) -> TurnEndReview {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return TurnEndReview() }
        return TurnEndReview(review: lenientValue(ChangeTotals.self, c, .review), merged: lenientValue(Bool.self, c, .merged) ?? false)
    }
}

// MARK: - §34.6 Live changes

/// One file of `live_changes`: changed by the running turn so far (never reviewable from here).
public struct LiveChangedFile: Sendable, Hashable, Identifiable, Decodable {
    public var id: String { path }
    public var path: String
    public var oldPath: String?
    public var status: ChangeStatus
    public var added: Int
    public var deleted: Int
    public var isBinary: Bool
    /// Also in the standing review (`changedFiles`).
    public var inReview: Bool
    public var generated: GeneratedKind?

    public init(path: String, oldPath: String? = nil, status: ChangeStatus = .modified, added: Int = 0, deleted: Int = 0,
                isBinary: Bool = false, inReview: Bool = false, generated: GeneratedKind? = nil) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.added = added
        self.deleted = deleted
        self.isBinary = isBinary
        self.inReview = inReview
        self.generated = generated
    }

    private enum CodingKeys: String, CodingKey { case path, oldPath, status, added, deleted, isBinary, inReview, generated }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(path: try c.decode(String.self, forKey: .path),
                  oldPath: lenientValue(String.self, c, .oldPath),
                  status: lenientValue(String.self, c, .status).flatMap(ChangeStatus.init(rawValue:)) ?? .other,
                  added: lenientValue(Int.self, c, .added) ?? 0, deleted: lenientValue(Int.self, c, .deleted) ?? 0,
                  isBinary: lenientValue(Bool.self, c, .isBinary) ?? false, inReview: lenientValue(Bool.self, c, .inReview) ?? false,
                  generated: lenientValue(String.self, c, .generated).map(GeneratedKind.init(raw:)))
    }
}

/// Reply to `live_changes`: the running turn's own start tree (`baseTree`) → a snapshot taken now (`liveTree`).
public struct LiveChanges: Sendable, Equatable, Decodable {
    public var id: String?
    /// false: no turn is running (`files` is empty).
    public var running: Bool
    public var turn: Int?
    public var baseTree: String?
    public var liveTree: String?
    /// ISO-8601: when `liveTree` was taken.
    public var at: String
    public var files: [LiveChangedFile]
    /// More than 200 files: the first 200.
    public var truncated: Bool

    public init(id: String? = nil, running: Bool, turn: Int? = nil, baseTree: String? = nil, liveTree: String? = nil, at: String = "",
                files: [LiveChangedFile] = [], truncated: Bool = false) {
        self.id = id
        self.running = running
        self.turn = turn
        self.baseTree = baseTree
        self.liveTree = liveTree
        self.at = at
        self.files = files
        self.truncated = truncated
    }

    private enum CodingKeys: String, CodingKey { case id, running, turn, baseTree, liveTree, at, files, truncated }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), running: lenientValue(Bool.self, c, .running) ?? false,
                  turn: lenientValue(Int.self, c, .turn), baseTree: lenientValue(String.self, c, .baseTree),
                  liveTree: lenientValue(String.self, c, .liveTree), at: lenientValue(String.self, c, .at) ?? "",
                  files: lenientElements(LiveChangedFile.self, c, .files), truncated: lenientValue(Bool.self, c, .truncated) ?? false)
    }
}

// MARK: - §34 fields of the state snapshot, decoded on their own so a bad value never fails the file / the gate

/// The §34 fields of one `changedFiles[]` entry.
struct ChangedFileReviewFields: Decodable {
    var changedThisTurn = false
    var turnAdded: Int?
    var turnDeleted: Int?
    var blob: String?
    var changedSinceAccepted = false
    var changedSinceRequest = false
    var generated: GeneratedKind?
    var whitespaceOnly = false
    var sentNoteCount = 0
    var why: FileWhy?

    private enum CodingKeys: String, CodingKey {
        case changedThisTurn, turnAdded, turnDeleted, blob, changedSinceAccepted, changedSinceRequest, generated, whitespaceOnly
        case sentNoteCount, why
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        changedThisTurn = lenientValue(Bool.self, c, .changedThisTurn) ?? false
        turnAdded = lenientValue(Int.self, c, .turnAdded)
        turnDeleted = lenientValue(Int.self, c, .turnDeleted)
        blob = lenientValue(String.self, c, .blob)
        changedSinceAccepted = lenientValue(Bool.self, c, .changedSinceAccepted) ?? false
        changedSinceRequest = lenientValue(Bool.self, c, .changedSinceRequest) ?? false
        generated = lenientValue(String.self, c, .generated).map(GeneratedKind.init(raw:))
        whitespaceOnly = lenientValue(Bool.self, c, .whitespaceOnly) ?? false
        sentNoteCount = lenientValue(Int.self, c, .sentNoteCount) ?? 0
        why = lenientValue(FileWhy.self, c, .why)
    }

    /// Never throws: a container that is not an object yields the defaults.
    static func lenient(from decoder: Decoder) -> ChangedFileReviewFields {
        (try? ChangedFileReviewFields(from: decoder)) ?? ChangedFileReviewFields()
    }

    private init() {}
}

/// The §34 fields of `state.gate`.
struct GateReviewFields: Decodable {
    var reviewEndTree: String?
    var reviewTurns: [Int] = []
    var lastTurnChanges: LastTurnChanges?
    var lastRequest: ReviewRequestInfo?

    private enum CodingKeys: String, CodingKey { case reviewEndTree, reviewTurns, lastTurnChanges, lastRequest }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        reviewEndTree = lenientValue(String.self, c, .reviewEndTree)
        reviewTurns = lenientElements(Int.self, c, .reviewTurns)
        lastTurnChanges = lenientValue(LastTurnChanges.self, c, .lastTurnChanges)
        lastRequest = lenientValue(ReviewRequestInfo.self, c, .lastRequest)
    }

    static func lenient(from decoder: Decoder) -> GateReviewFields {
        (try? GateReviewFields(from: decoder)) ?? GateReviewFields()
    }

    private init() {}
}

/// The §34 fields of `turn_summary` (top level and per file).
struct TurnSummaryReviewFields {
    private enum CodingKeys: String, CodingKey { case review, merged, lastTest, whyDetail, reviewAdds, reviewDels }

    static func summary(from decoder: Decoder) -> (review: ChangeTotals?, merged: Bool, lastTest: LastTest?) {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return (nil, false, nil) }
        return (lenientValue(ChangeTotals.self, c, .review), lenientValue(Bool.self, c, .merged) ?? false, lenientValue(LastTest.self, c, .lastTest))
    }

    static func file(from decoder: Decoder) -> (whyDetail: FileWhy?, reviewAdds: Int?, reviewDels: Int?) {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return (nil, nil, nil) }
        return (lenientValue(FileWhy.self, c, .whyDetail), lenientValue(Int.self, c, .reviewAdds), lenientValue(Int.self, c, .reviewDels))
    }
}

/// The §34.8 fields of a `tool_use` (event and transcript row).
struct ToolUseReviewFields {
    private enum CodingKeys: String, CodingKey { case rationaleSource, rationaleAge }

    static func lenient(from decoder: Decoder) -> (source: RationaleSource?, age: Int?) {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return (nil, nil) }
        return (lenientValue(String.self, c, .rationaleSource).map(RationaleSource.init(raw:)), lenientValue(Int.self, c, .rationaleAge))
    }
}

// MARK: - Helpers

/// A field that may be missing, null or of another type (→ nil).
func lenientValue<T: Decodable, K: CodingKey>(_ type: T.Type, _ c: KeyedDecodingContainer<K>, _ key: K) -> T? {
    guard let value = try? c.decodeIfPresent(T.self, forKey: key) else { return nil }
    return value
}

/// `[T]` element by element, dropping the elements that do not decode.
func lenientElements<T: Decodable, K: CodingKey>(_ type: T.Type, _ c: KeyedDecodingContainer<K>, _ key: K) -> [T] {
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
