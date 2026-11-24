import Foundation

// MARK: accept-continue-ui — docs/PROTOCOL.md §58.1
// "Accept All & Continue", the Changes header's primary button (and the composer's pending banner): every pending file
// accepted, then Claude told to go on — a chat through §58's `send {acceptPending}`, a terminal chat through its own
// paste-and-Enter. And the review list's folded "Accepted · not committed (N)" group: accepted files leave the open part
// of the list and its progress; a file that is pending again is back in the open part.

extension AppState {
    /// Why "Accept All & Continue" is off (nil: on), for either kind of chat: nothing pending, another chat shown read-only,
    /// a terminal chat's own rule (Claude Code idle at its prompt, §58), else the message box's (a file sent back for
    /// changes, Claude working, a card waiting — the send's reasons).
    public var acceptAllContinueBlocker: String? {
        guard !pendingFiles.isEmpty else { return TerminalFrictionText.nothingPending }
        if viewingChat != nil { return AcceptAllContinueText.showRunningChat }
        if isTerminalChat { return terminalAcceptContinueBlocker }
        if !changesRequestedFiles.isEmpty {
            return String(localized: "Send your change request (\(changesRequestedFiles.count) file(s)) to continue", bundle: .module)
        }
        if !canAcceptAndContinue { return cannotSendReason ?? String(localized: "Claude can't take a message right now", bundle: .module) }
        return nil
    }

    /// The review list's open part: every changed file but the accepted ones (those are in the folded group).
    public var openChangedFiles: [ChangedFile] { changedFiles.filter { $0.state != .accepted } }

    /// Accepted and not committed yet: the folded group at the bottom of the review list.
    public var acceptedChangedFiles: [ChangedFile] { changedFiles.filter { $0.state == .accepted } }

    /// The header's "3/7 viewed": the open files whose diff was shown (an accepted file is out of the count).
    public var viewedOpenCount: Int {
        let viewed = viewedPaths
        return changedFiles.reduce(0) { $0 + ($1.state != .accepted && viewed.contains($1.path) ? 1 : 0) }
    }
}

/// The review list split in two: the open sections and the accepted files folded under one header.
public enum AcceptedGroup {
    /// Accepted files leave their section (a section left empty is not listed) and come back as one list, in the order the
    /// sections showed them.
    public static func split(_ sections: [ChangedFileSection]) -> (open: [ChangedFileSection], accepted: [ChangedFile]) {
        var open: [ChangedFileSection] = []
        var accepted: [ChangedFile] = []
        for section in sections {
            var kept = section
            kept.files = section.files.filter { $0.state != .accepted }
            accepted += section.files.filter { $0.state == .accepted }
            if !kept.files.isEmpty { open.append(kept) }
        }
        return (open, accepted)
    }

    /// "수락함 · 커밋 전 N".
    public static func title(_ count: Int) -> String {
        String(localized: "Accepted · not committed (\(count))", bundle: .module)
    }

    public static var help: String {
        String(localized: "Files you accepted that are not committed yet — Commit… takes them; Undo Accept makes one pending again", bundle: .module)
    }
}

/// §58.1 in the user's words.
public enum AcceptAllContinueText {
    /// The button: "모두 수락하고 계속".
    public static var title: String { String(localized: "Accept All & Continue", bundle: .module) }

    public static var showRunningChat: String {
        String(localized: "This review belongs to the running chat — show it to continue Claude there", bundle: .module)
    }
}
