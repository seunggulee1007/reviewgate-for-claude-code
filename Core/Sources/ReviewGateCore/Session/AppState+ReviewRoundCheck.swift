import Foundation

// MARK: wave3 check-clients
// docs/PROTOCOL.md §34 on the Mac where 0.2.2 differed from Electron or misled: "요청 후 바뀌지 않음" (a file with sent
// notes the collected follow-up left alone), the HUD's "진행 중" chip from `hud.turnFiles` on (before, it waited for a
// `live_changes` list with files and stayed away when the first one came back empty), "반영 확인" waiting while the change
// request it answers runs (the engine refuses `remove_note` then), and Accept all counting a file viewed-then-changed
// once ("not viewed" and "본 뒤 바뀜" apart, pending files only); the turn summary card's whole-review totals apart from
// this turn's own numbers.

public extension ReviewRange {
    /// "요청 후 바뀌지 않음": `file` carries sent notes and the collected follow-up of the last request left it as it was at
    /// the request (Electron's `unchangedSinceRequest`). False until that follow-up is collected — it may still change it.
    static func unchangedSinceRequest(_ file: ChangedFile, gate: GateInfo) -> Bool {
        guard file.sentNoteCount > 0, !file.changedSinceRequest, let request = gate.lastRequest,
              let collected = gate.lastTurnChanges else { return false }
        return collected.turn >= request.turn
    }
}

public extension TurnSummary {
    /// The card's "리뷰 전체: 파일 N개 · +A −D" next to this turn's own numbers (§34.3, Electron's `summaryReviewTotals`):
    /// only for a turn merged into a standing review (a question, a change request's follow-up) — a fresh turn's review
    /// is that turn, and an engine before §34 sends neither field.
    var reviewTotalsShown: ChangeTotals? { merged ? review : nil }

    /// The card's test line (§34.9), the same rule as Electron's `testVerdict`.
    var testVerdict: TestVerdictLine? { TestVerdictLine(lastTest, reported: lastTestReported) }
}

extension TurnSummary {
    /// `turn_summary` carries the `lastTest` key (a null one included).
    static func reportsLastTest(_ decoder: Decoder) -> Bool {
        enum Keys: String, CodingKey { case lastTest }
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return false }
        return c.contains(.lastTest)
    }
}

public extension TestVerdictLine {
    /// The line for a summary: a §34 engine's `lastTest: null` (`reported`) is "편집 뒤 테스트 없음" in grey — nothing was
    /// tested this turn — as in Electron; nil only for an engine before §34 (the old count chips) or an unknown verdict.
    init?(_ lastTest: LastTest?, reported: Bool) {
        guard let lastTest else {
            guard reported else { return nil }
            self = .noTestRun
            return
        }
        self.init(lastTest)
    }

    /// The tooltip: the command as typed ("$ …", "· ×N" for several runs); a run an edit came after says what it said.
    func help(_ lastTest: LastTest?) -> String? {
        if self == .noTestRun { return String(localized: "No test command ran in this turn", bundle: .module) }
        guard let lastTest else { return nil }
        let command = lastTest.command.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let runs = lastTest.runs > 1 ? " · ×\(lastTest.runs)" : ""
        let line = "$ \(command)\(runs)"
        guard self == .noTestAfterEdit else { return line }
        let said = lastTest.verdict == .fail
            ? String(localized: "The last test failed before a later edit", bundle: .module)
            : String(localized: "The last test passed before a later edit", bundle: .module)
        return said + "\n" + line
    }
}

/// The HUD's "진행 중: 파일 N개 · +A −D": the files the running turn touched (`hud.turnFiles`, at least the listed ones);
/// `added` / `deleted` only from a `live_changes` list that has every one of them (nil: "진행 중: 파일 N개").
public struct LiveChipSummary: Equatable, Sendable {
    public var files: Int
    public var added: Int?
    public var deleted: Int?

    public init(files: Int, added: Int?, deleted: Int?) {
        self.files = files
        self.added = added
        self.deleted = deleted
    }

    /// nil when the turn has touched nothing yet (or an engine before §34 says nothing).
    public init?(turnFiles: Int, live: LiveChanges?) {
        let listed = live?.running == true ? live?.files ?? [] : []
        let files = max(turnFiles, listed.count)
        guard files > 0 else { return nil }
        let complete = live?.running == true && !listed.isEmpty && listed.count >= turnFiles
        self.init(files: files,
                  added: complete ? listed.reduce(0) { $0 + $1.added } : nil,
                  deleted: complete ? listed.reduce(0) { $0 + $1.deleted } : nil)
    }
}

extension AppState {
    /// "요청 후 바뀌지 않음" for a file of the list.
    public func unchangedSinceRequest(_ file: ChangedFile) -> Bool { ReviewRange.unchangedSinceRequest(file, gate: gate) }

    /// The HUD chip and the Changes list's "진행 중 변경" section while a turn runs (or is collected) and has touched files.
    public var liveChip: LiveChipSummary? {
        guard isRunning || isSnapshotting else { return nil }
        return LiveChipSummary(turnFiles: hudTurnFiles, live: liveChanges)
    }

    /// Why a note cannot be added or removed now ("반영 확인", delete): a change request's follow-up runs or is collected.
    public var noteLockReason: String? { isNoteLocked ? Self.sessionRefusalText("session_running") : nil }

    /// Pending files never shown in this review ("아직 확인 안 함").
    public var neverViewedPendingFiles: [ChangedFile] { pendingFiles.filter { viewedContent[$0.path] == nil } }

    /// Pending files shown, then changed ("본 뒤 바뀜"): a decided file has nothing left to look at.
    public var changedSinceViewedPendingFiles: [ChangedFile] { pendingFiles.filter(changedSinceViewed) }

    /// The "본 뒤 바뀜" chip of a row: pending files only (as Electron).
    public func showsChangedSinceViewed(_ file: ChangedFile) -> Bool { file.state == .pending && changedSinceViewed(file) }

    /// What a range other than the whole review leaves to "전체" (§34.1: its hunk ids and old-side numbers are not A's),
    /// said next to the range picker instead of the controls just going away (Electron's range row and hunk bar): the
    /// line / part side questions, and for a file that could be reverted in parts, that.
    public func rangeHints(for file: ChangedFile) -> [String] {
        guard diffSince(for: file) != .review else { return [] }
        var hints: [String] = []
        if side.isSupported { hints.append(String(localized: "Line side questions are in the “Whole review” view", bundle: .module)) }
        if file.supportsHunkReject { hints.append(String(localized: "Parts can be reverted in the “Whole review” view", bundle: .module)) }
        return hints
    }
}
