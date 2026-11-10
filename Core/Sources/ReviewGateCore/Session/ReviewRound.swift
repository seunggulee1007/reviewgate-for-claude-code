import Foundation

// wave2 mac-flow — docs/PROTOCOL.md §34 ("리뷰 2차") as testable logic: which ranges a file's diff offers and which one it
// opens in, "봤음" keyed on content, where a note sits in the diff on screen and the turn-end row (the live-changes
// summary is `LiveChipSummary`, AppState+ReviewRoundCheck.swift). The window's store uses these in AppState+ReviewRound.swift.

// MARK: - Trees and ranges (§34.1)

public extension GateInfo {
    /// The B the review list, every diff and `blob` refer to: `reviewEndTree` (B, or while a turn runs the B it started
    /// from), else an older engine's `turnEndTree`. nil without a review, and while a turn runs on a fresh one.
    var reviewTree: String? { reviewEndTree ?? turnEndTree }
}

public extension DiffSince {
    /// The diff header's range label (both clients share these keys).
    var label: String {
        switch self {
        case .review: String(localized: "Whole review", bundle: .module)
        case .turn: String(localized: "This turn", bundle: .module)
        case .request: String(localized: "Since request", bundle: .module)
        case .accepted: String(localized: "Since accepted", bundle: .module)
        }
    }

    /// What `select_file` / `full_file` carry: nothing for the whole review (an older engine never sees the field).
    var wire: DiffSince? { self == .review ? nil : self }
}

/// The ranges of one file's diff (§34.1) and the one it opens in.
public enum ReviewRange {
    /// The ranges the diff header offers for `file`, the whole review first; a single entry means no picker. A range is
    /// offered only when it shows something the whole review does not: "이번 턴" once the review spans several turns and
    /// this turn touched the file (not when that turn is the change request's own follow-up — "요청 이후" says it),
    /// "요청 이후" for a file the follow-up changed, "수락 이후" for a file changed after it was accepted.
    public static func available(for file: ChangedFile, gate: GateInfo) -> [DiffSince] {
        var out: [DiffSince] = [.review]
        let request = gate.lastRequest != nil && file.changedSinceRequest
        let lastTurn = gate.lastTurnChanges?.turn ?? gate.reviewTurns.last
        let turnIsTheRequestsFollowUp = request && lastTurn != nil && gate.lastRequest?.turn == lastTurn
        if file.changedThisTurn, gate.reviewTurns.count > 1, !turnIsTheRequestsFollowUp { out.append(.turn) }
        if request { out.append(.request) }
        if file.changedSinceAccepted { out.append(.accepted) }
        return out
    }

    /// The range a pending file opens in: accepted, then changed again → "수락 이후"; sent back with notes and changed by
    /// the follow-up → "요청 이후"; anything else (a file nobody decided on yet included) → the whole review, so a part
    /// that was never looked at is never hidden.
    public static func defaultRange(for file: ChangedFile, gate: GateInfo) -> DiffSince {
        guard file.state == .pending else { return .review }
        if file.changedSinceAccepted { return .accepted }
        if gate.lastRequest != nil, file.changedSinceRequest, file.sentNoteCount > 0 { return .request }
        return .review
    }
}

/// The range a file's diff was opened or picked in, with the content it was chosen on: a new content (the file changed
/// again) brings the default back; anything else (a note removed, another file decided) keeps it.
struct ReviewRangeChoice: Equatable, Sendable {
    var since: DiffSince
    var content: String
}

/// A cached diff is one file's range on one B (§34.1: clients key caches on path, since and `reviewEndTree`).
struct ReviewDiffKey: Hashable, Sendable {
    var path: String
    var since: DiffSince
    var tree: String
}

/// One `file_diff` reply as the diff pane shows it.
struct ReviewDiffEntry: Sendable, Equatable {
    var diff: FileDiff
    var truncated: Bool
    /// `file_diff.endTree` — what `reject_hunks.expectedEndTree` echoes.
    var endTree: String?
    var info: FileDiffInfo
}

// MARK: - Viewed (§34.5)

/// "봤음" is (path, content): clearing it is up to the content, never to B moving.
public enum ViewedKey {
    /// The content next to the path: the blob in B, `"deleted"` without one. An engine before §34 sends no blob; its
    /// status and line counts stand in for it, so a reject elsewhere never clears the mark and a re-edit usually does.
    public static func content(_ file: ChangedFile) -> String {
        if let blob = file.blob { return blob }
        if file.status == .deleted { return "deleted" }
        return "stat:\(file.status.rawValue):\(file.added):\(file.deleted)"
    }
}

// MARK: - Notes (§34.4)

/// Where a review note goes in the diff on screen.
public enum NotePlacement {
    /// The notes drawn under the diff line `(side, line)` of `path` in the range `since`. An old-side note is anchored
    /// in the whole review only (its numbers are A's); a note whose line is gone is never drawn on a line.
    public static func inline(_ notes: [ReviewNote], path: String, side: DiffSide, line: Int?, since: DiffSince) -> [ReviewNote] {
        guard let line else { return [] }
        return notes.filter { $0.path == path && $0.side == side && $0.line == line && isAnchored($0, since: since) }
    }

    /// The notes of `path` that have no line in `diff` — gone lines ("위치 사라짐"), notes without a line, old-side notes
    /// outside the whole review, lines the range does not show — listed above the diff instead of being lost. Empty while
    /// the diff loads.
    public static func displaced(_ notes: [ReviewNote], path: String, since: DiffSince, diff: FileDiff?) -> [ReviewNote] {
        guard let diff else { return [] }
        var visible = Set<LineRef>()
        for line in diff.allLines {
            switch line.kind {
            case .add, .context: if let no = line.newNo { visible.insert(LineRef(side: .new, line: no)) }
            case .del: if let no = line.oldNo { visible.insert(LineRef(side: .old, line: no)) }
            case .hunkHeader: break
            }
        }
        return notes.filter { note in
            guard note.path == path else { return false }
            guard let line = note.line, isAnchored(note, since: since) else { return true }
            return !visible.contains(LineRef(side: note.side, line: line))
        }
    }

    /// The unsent notes — what request_changes sends, what `canRequestChanges` and every "notes pending" guard count.
    public static func unsent(_ notes: [ReviewNote]) -> [ReviewNote] { notes.filter { $0.sent == nil } }

    // MARK: wave7 w7-state — §45.2: every line's notes at once (a diff row looks its own up instead of filtering them all)

    /// A diff line by its side and number.
    public struct LineKey: Hashable, Sendable {
        public var side: DiffSide
        public var line: Int

        public init(side: DiffSide, line: Int) {
            self.side = side
            self.line = line
        }
    }

    /// `inline(notes, path:, side:, line:, since:)` of every line of `path`, in one pass (the same notes, the same order).
    public static func inlineByLine(_ notes: [ReviewNote], path: String, since: DiffSince) -> [LineKey: [ReviewNote]] {
        var out: [LineKey: [ReviewNote]] = [:]
        for note in notes where note.path == path && isAnchored(note, since: since) {
            guard let line = note.line else { continue }
            out[LineKey(side: note.side, line: line), default: []].append(note)
        }
        return out
    }

    static func isAnchored(_ note: ReviewNote, since: DiffSince) -> Bool {
        if note.anchor == .gone { return false }
        return note.side == .new || since == .review
    }

    private struct LineRef: Hashable {
        var side: DiffSide
        var line: Int
    }
}

// MARK: - Turn end (§34.3)

public enum TurnEndText {
    /// The transcript's turn-end line. `files` / `added` / `deleted` are what THIS turn changed; a turn merged into a
    /// standing review (a question, a change request's follow-up) also says what the whole review holds now.
    public static func row(stopReason: String, usage: Usage, files: Int, added: Int, deleted: Int, external: Int,
                           review: TurnEndReview) -> String {
        var summary: String
        let why = stopWords(stopReason)   // wave4b w4b-check4 (§40.1): words, not the raw stopReason
        if review.merged, let total = review.review {
            summary = String(localized: "This turn changed \(files) file(s) (+\(added) −\(deleted)) · review \(total.files) file(s) (+\(total.added) −\(total.deleted)) · \(why)", bundle: .module)
        } else {
            summary = String(localized: "Changed \(files) file(s) (+\(added) −\(deleted)) · \(why)", bundle: .module)
        }
        summary += String(format: " · $%.4f · %.1fs", usage.costUsd, Double(usage.durationMs) / 1000)
        if external > 0 { summary += " · " + ReviewProvenanceText.externalIncluded(external) }   // wave1 mac-review
        return summary
    }
}

// MARK: - Settings

public extension AppSettings.Key {
    /// The Changes list's order (Bool, default true = riskiest first): ⌘] / ⌘[ and the move after a verdict follow it.
    static let changedFilesRiskOrder = "changedFilesRiskOrder"
}
