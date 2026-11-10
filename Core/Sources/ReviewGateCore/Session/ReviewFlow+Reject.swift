import Foundation

// MARK: r2-review-flow — reviewing without extra clicks or modal stops (release 2) on the Mac: the rules both the views and
// the tests read.
// · M32 (docs/PROTOCOL.md §34.2): a reject while Claude works waits for the turn's end (`rejectScheduled`) and says so in gray
//   rows; a file the turn changed again is asked about in its row.

/// The wire field of M32 (lenient: absent or malformed on an older engine → false).
enum ReviewFlowWire {
    private enum FileKeys: String, CodingKey { case rejectScheduled }

    /// `changedFiles[].rejectScheduled`: the reject waits for the running turn's end.
    static func rejectScheduled(from decoder: Decoder) -> Bool {
        guard let c = try? decoder.container(keyedBy: FileKeys.self) else { return false }
        return ((try? c.decodeIfPresent(Bool.self, forKey: .rejectScheduled)) ?? nil) ?? false
    }
}

// MARK: - M32 rows and the scheduled state

/// The words of M32 (English keys, Korean in the catalog; Electron uses the same keys).
public enum ReviewFlowText {
    /// The rows about a reject during a turn: gray chat rows only (no banner, the queue goes on).
    public static let rowOnlyCodes: Set<String> = ["reject_scheduled", "reject_applied", "reject_changed_again"]

    public static func isRowOnly(_ code: String?) -> Bool { code.map(rowOnlyCodes.contains) ?? false }

    /// Their color: information (gray).
    public static func style(_ code: String?) -> NoticeStyle? { isRowOnly(code) ? .info : nil }

    /// The row text of an M32 code; nil for any other code. `detail` is the engine's (the files, or the one file asked about).
    public static func errorText(message: String, detail: EngineErrorDetail) -> String? {
        let what = detail.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch detail.code {
        case "reject_scheduled":
            return String(localized: "Rejected while Claude works: \(what) — reverted when the turn ends; Claude was told not to build on it", bundle: .module)
        case "reject_applied":
            return String(localized: "Reverted as you asked while Claude worked: \(what)", bundle: .module)
        case "reject_changed_again":
            return String(localized: "Claude changed this again after you rejected it, so it was not reverted: \(what)", bundle: .module)
        default:
            return nil
        }
    }

    /// The file a `reject_changed_again` row asks about (its `detail`); nil for any other row.
    public static func askedPath(code: String?, detail: String?) -> String? {
        guard code == "reject_changed_again", let path = detail?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty else { return nil }
        return path
    }

    /// The row's [되돌리기] while that file is still pending in the review (another turn or a decision may have settled it).
    public static func asksStill(_ path: String, in files: [ChangedFile]) -> Bool {
        files.contains { $0.path == path && $0.state == .pending && !$0.rejectScheduled }
    }

    /// The changed-file chip: "거절 예정".
    public static var scheduledBadge: String { String(localized: "Reject scheduled", bundle: .module) }

    /// The chip's tooltip.
    public static var scheduledHelp: String {
        String(localized: "Reverted when Claude's turn ends — Claude was told not to build on it. Accept the file to keep it.", bundle: .module)
    }

    /// The row's [되돌리기] tooltip.
    public static var revertAgainHelp: String {
        String(localized: "Reject the file as it is now — its changes go back to the start of the review", bundle: .module)
    }
}
