import Foundation

// MARK: r1-scope
// docs/PROTOCOL.md §33.4 / §39.5 on the client: what already ran outside this window's review is a chat row — never a
// banner, never `lastError` — naming the files a command changed there, with the folder's actions (move this chat there,
// open it as a workbench or a folder).

public enum ScopeText {
    /// At most this many file names on a row; the rest are counted.
    public static let shownFiles = 8

    /// `worktree_outside_review` is a chat row only: no banner, no `lastError`, never a stopped queue.
    public static func isRowOnly(_ code: String?) -> Bool { code == "worktree_outside_review" }

    /// The row's sentence when the engine named the files (a command run in another worktree / nested repository); nil
    /// otherwise (the §33.4 sentence of `SessionNotices` stands).
    public static func errorText(message: String, detail: EngineErrorDetail) -> String? {
        guard detail.code == "worktree_outside_review", let files = detail.files, !files.isEmpty else { return nil }
        guard let path = detail.path, !path.isEmpty else {
            return String(localized: "Changed where this window's review does not see it", bundle: .module)
        }
        let shown = SessionNotices.abbreviatingHome(path)
        return String(localized: "Changed where this window's review does not see it: \(shown)", bundle: .module)
    }

    /// The row's second line: the files (the first `shownFiles`, then how many more); nil without files.
    public static func filesLine(_ files: [String]) -> String? {
        guard !files.isEmpty else { return nil }
        let head = files.prefix(shownFiles).joined(separator: ", ")
        let more = files.count - min(files.count, shownFiles)
        return more > 0 ? head + " " + String(localized: "and \(more) more", bundle: .module) : head
    }

    /// A row of `worktree_outside_review`: the folder for its actions, the files on its second line — and as its merge
    /// identity, so two rows naming other files never fold into one ×N.
    public static func rowInfo(_ info: ErrorRowInfo, detail: EngineErrorDetail?) -> ErrorRowInfo {
        guard let detail, detail.code == "worktree_outside_review" else { return info }
        var out = info
        out.path = detail.path
        if let files = detail.files, !files.isEmpty {
            out.secondary = filesLine(files)
            out.detail = files.joined(separator: "\n")
        }
        return out
    }

    /// The row's actions (`SessionNotices.bannerActions`): move this chat there and open it as a workbench when `path` is
    /// one of the repository's worktrees, else open the folder.
    public static func rowActions(_ info: ErrorRowInfo, isWorkbench: (String) -> Bool) -> [EngineMessageAction] {
        guard info.code == "worktree_outside_review", let path = info.path, !path.isEmpty else { return [] }
        return SessionNotices.bannerActions(code: info.code, repeats: info.count, path: path, pathIsWorkbench: isWorkbench(path))
    }
}

enum ScopeWire {
    private enum ErrorKeys: String, CodingKey { case files }

    /// §33.4: the files of a `worktree_outside_review` event / row (nil when the engine sent none).
    static func applyErrorFacts(from decoder: Decoder, to detail: inout EngineErrorDetail) {
        guard let c = try? decoder.container(keyedBy: ErrorKeys.self), c.contains(.files) else { return }
        detail.files = lenientElements(String.self, c, .files)
    }
}
