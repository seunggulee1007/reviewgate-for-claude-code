import Foundation

// MARK: r1-git
// docs/PROTOCOL.md §46 / §31.3 on the Mac: git runs as in the terminal; what Claude's own git commands did is told after the
// fact — a file Claude committed keeps its place in the review with a "커밋됨 <sha>" badge, a HEAD move Claude made is a
// gray chat row instead of the head-moved bar, and a stash that took files out of the working tree names them.

/// The wire fields of §46 (lenient: absent or malformed on an older engine → nil).
enum GitWire {
    private enum FileKeys: String, CodingKey { case committedIn }

    /// `changedFiles[].committedIn`: the short sha of Claude's own commit holding the change.
    static func committedIn(from decoder: Decoder) -> String? {
        guard let c = try? decoder.container(keyedBy: FileKeys.self) else { return nil }
        let sha = (try? c.decodeIfPresent(String.self, forKey: .committedIn)) ?? nil
        return sha?.isEmpty == false ? sha : nil
    }
}

/// The words of §46 (English keys, Korean in the catalog; Electron uses the same keys).
public enum GitNoticeText {
    /// The notices that stay chat rows only (no banner, no paused queue).
    public static let rowOnlyCodes: Set<String> = ["git_stashed", "claude_committed", "claude_moved_head", "reject_committed"]

    public static func isRowOnly(_ code: String?) -> Bool { code.map(rowOnlyCodes.contains) ?? false }

    /// The row's color: information (gray), as on Electron.
    public static func style(_ code: String?) -> NoticeStyle? {
        isRowOnly(code) ? .info : nil
    }

    /// The row text of a §46 code; nil for any other code. `detail` is the engine's (files, short shas, `from → to`).
    public static func errorText(message: String, detail: EngineErrorDetail) -> String? {
        let what = detail.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch detail.code {
        case "git_stashed":
            return String(localized: "Stashed and out of the review: \(what) (git stash pop brings them back)", bundle: .module)
        case "claude_committed":
            return String(localized: "Claude committed \(what) — its files stay in the review", bundle: .module)
        case "claude_moved_head":
            return String(localized: "Claude's git command moved HEAD (\(what)) — the review shows only Claude's changes", bundle: .module)
        case "reject_committed":
            return String(localized: "Reverted on disk — Claude's commit still holds the change: \(what) (git reset --soft or git revert undoes it)", bundle: .module)
        default:
            return nil
        }
    }

    /// The changed-file badge: "커밋됨 abc1234".
    public static func committedBadge(_ sha: String) -> String {
        String(localized: "Committed \(sha)", bundle: .module)
    }

    /// The badge's tooltip: the file stays in the review; a reject reverts the working tree, the commit stays.
    public static func committedHelp(_ sha: String) -> String {
        String(localized: "Claude committed this change in \(sha); the file stays in the review. Rejecting it reverts the working tree — the commit stays (git reset --soft undoes it).", bundle: .module)
    }
}
