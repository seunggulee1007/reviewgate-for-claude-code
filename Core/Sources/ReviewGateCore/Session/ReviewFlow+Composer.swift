import Foundation

// MARK: r2-review-flow — reviewing without extra clicks or modal stops (release 2) on the Mac: the rules both the views and
// the tests read.
// · M30 (§3): a failed collection no longer closes the input; ↩ with text always does something — it sends, puts the text
//   into the turn, queues it (any closed gate of an open project, as Electron), or restarts an ended session and sends.

// MARK: - M30 the composer's ↩

/// What ↩ (or ⌘↩) does with the typed message (`ComposerSendRules.returnAction`).
public enum ComposerSendAction: Equatable, Sendable {
    /// Sent as the next turn.
    case send
    /// Into the running turn (§50).
    case steer
    /// Into the queue: it goes out once the session takes a message.
    case queue
    /// The session ended: queued, and the session restarts (the queue sends it once the session is up).
    case restartAndSend
    /// Nothing can take it now — the caller says why (never a silent no-op).
    case nothing
}

public enum ComposerSendRules {
    /// As Electron: with a project open and the gate closed — Claude working, a collection, a revert, a start, a session that
    /// ended — the message waits in the queue. Never from another chat shown read-only.
    public static func canQueue(projectOpen: Bool, canSend: Bool, viewing: Bool) -> Bool {
        !viewing && projectOpen && !canSend
    }

    /// The action of ↩ with `hasText`: send when the gate is open; while Claude works into the turn (`canSteer`) or the
    /// queue; an ended session is restarted (when it can be) with the message queued; else nothing (the caller explains).
    public static func returnAction(hasText: Bool, canSend: Bool, canQueue: Bool, canSteer: Bool, sessionEnded: Bool, canRestart: Bool) -> ComposerSendAction {
        guard hasText else { return .nothing }
        if canSend { return .send }
        if sessionEnded { return canRestart ? .restartAndSend : (canQueue ? .queue : .nothing) }
        if canSteer { return .steer }
        if canQueue { return .queue }
        return .nothing
    }

    /// The composer's notice line while a collection failed: the input is open, the next message folds the failed turn in.
    public static func collectFailedNotice(_ detail: String) -> String {
        let reason = detail.split(whereSeparator: \.isNewline).first.map(String.init) ?? detail
        return String(localized: "Could not collect the last turn's changes (\(reason)) — your next message collects them with its own", bundle: .module)
    }
}
