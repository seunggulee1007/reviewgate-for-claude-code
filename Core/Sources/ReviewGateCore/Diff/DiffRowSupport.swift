import Foundation

// MARK: wave4d w4d-speed — audit polish-09 / polish-10 (no wire change): what the diff pane looks up per row, built once per
// diff instead of walking the whole diff for every row it draws, and the words VoiceOver reads for a diff line and a changed
// file. Electron's screen-reader text (`a11yText.ts`) uses the same English keys, so both clients say the same words.

/// Per-diff lookups of the diff pane, built once per diff (`DiffPlanCache.index`): a body evaluation of the pane — a click, a
/// note, a fold — never builds `FileDiff.allLines` or a header map again for each row it draws.
public struct FileDiffIndex: Sendable, Equatable {
    /// The diff's lines, hunk headers included — `FileDiff.allLines.count` without building the array.
    public let lineCount: Int
    /// A hunk header line's `DiffLine.id` → its `DiffHunk.id` (the id `reject_hunks` takes).
    public let hunkByHeader: [Int: Int]

    public init(_ diff: FileDiff) {
        var count = 0
        var headers: [Int: Int] = [:]
        for hunk in diff.hunks {
            count += hunk.lines.count
            if let header = hunk.lines.first(where: { $0.kind == .hunkHeader }) { headers[header.id] = hunk.id }
        }
        lineCount = count
        hunkByHeader = headers
    }
}

/// What VoiceOver reads for the review's rows: a diff line is one element ("Added line 42: …"), a changed file's status
/// letter and review dot are words, "+12 −3" is "12 lines added, 3 removed".
public enum ReviewSpeech {
    /// The status letter (M / A / D / R / X) as a word.
    public static func status(_ status: ChangeStatus) -> String {
        switch status {
        case .modified: String(localized: "Modified", bundle: .module)
        case .added: String(localized: "Added", bundle: .module)
        case .deleted: String(localized: "Deleted", bundle: .module)
        case .renamed: String(localized: "Renamed", bundle: .module)
        case .other: String(localized: "Other change", bundle: .module)
        }
    }

    /// A file's review state (the dot, the check, the arrow at the end of its row).
    public static func state(_ state: FileReviewState) -> String {
        switch state {
        case .pending: String(localized: "Pending review", bundle: .module)
        case .accepted: String(localized: "Accepted", bundle: .module)
        case .rejected: String(localized: "Rejected", bundle: .module)
        case .changesRequested: String(localized: "Changes requested", bundle: .module)
        }
    }

    /// "+12 −3" read out.
    public static func counts(added: Int, deleted: Int) -> String {
        String(localized: "\(added) lines added, \(deleted) removed", bundle: .module)
    }

    /// What a diff row says before its code: its kind and the number on its own side.
    public static func linePrefix(_ line: DiffLine) -> String {
        switch line.kind {
        case .add:
            line.newNo.map { String(localized: "Added line \($0):", bundle: .module) } ?? String(localized: "Added line:", bundle: .module)
        case .del:
            line.oldNo.map { String(localized: "Removed line \($0):", bundle: .module) } ?? String(localized: "Removed line:", bundle: .module)
        case .context:
            (line.newNo ?? line.oldNo).map { String(localized: "Unchanged line \($0):", bundle: .module) }
                ?? String(localized: "Unchanged line:", bundle: .module)
        case .hunkHeader:
            String(localized: "Changed part:", bundle: .module)
        }
    }

    /// The whole row as one element: the prefix, the drawn code (cut where the row cuts it) or "(blank line)", and
    /// "Only whitespace changed" for a whitespace-only pair.
    public static func line(_ line: DiffLine) -> String {
        let text = DiffLineText.shown(line.text).text
        let blank = line.kind != .hunkHeader && text.allSatisfy(\.isWhitespace)
        var out = linePrefix(line) + " " + (blank ? String(localized: "(blank line)", bundle: .module) : text)
        if line.wsOnly, line.kind == .add || line.kind == .del {
            out += ", " + String(localized: "Only whitespace changed", bundle: .module)
        }
        return out
    }
}
