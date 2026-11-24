import Foundation

// MARK: accept-continue-ui — docs/PROTOCOL.md §58.1
// "Accept All & Continue", the Changes header's primary button (and the composer's pending banner): every pending file
// accepted, then Claude told to go on — a chat through §58's `send {acceptPending}`, a terminal chat through its own
// paste-and-Enter.

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
}

/// §58.1 in the user's words.
public enum AcceptAllContinueText {
    /// The button: "모두 수락하고 계속".
    public static var title: String { String(localized: "Accept All & Continue", bundle: .module) }

    public static var showRunningChat: String {
        String(localized: "This review belongs to the running chat — show it to continue Claude there", bundle: .module)
    }
}
