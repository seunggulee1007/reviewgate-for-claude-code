import Foundation

// MARK: wave1 mac-session
// docs/PROTOCOL.md §29 (peer messages) in the user's words: the inbox card, the transcript rows, the composer while an
// external turn runs, and the refusals of `peer_accept` / `peer_dismiss` / `peer_set`.

public enum PeerText {
    // MARK: Card (`state.session.peerInbox`)

    /// "<name> sent a message" — one line per sender on the card.
    public static func sentMessage(from name: String) -> String {
        String(localized: "\(name) sent a message", bundle: .module)
    }

    /// The card's title when several messages wait.
    public static func messagesTitle(count: Int) -> String {
        String(localized: "\(count) messages from other sessions", bundle: .module)
    }

    public static var cardHint: String {
        String(localized: "Claude sees the content once you hand it over · the name is what the sender says", bundle: .module)
    }

    /// `cause == "mode-mismatch"`.
    public static var modeMismatch: String {
        String(localized: "(held because the sending session runs in another permission mode)", bundle: .module)
    }

    public static var delivering: String { String(localized: "Handing over…", bundle: .module) }
    public static var reviewNote: String { String(localized: "Its changes join the current review", bundle: .module) }
    public static var waitForWork: String { String(localized: "Available once the current work finishes", bundle: .module) }
    public static var waitForOtherWork: String { String(localized: "Available once the other work finishes", bundle: .module) }
    public static var inboxChanged: String {
        String(localized: "A new message arrived and the list changed. Check it again", bundle: .module)
    }

    // MARK: Transcript rows (`peer_message` event / `kind: "peer_message"`)

    /// The delivered row's header.
    public static func deliveredHeader(_ message: PeerMessage) -> String {
        String(localized: "Other Claude session · \(message.senderName)", bundle: .module)
    }

    public static func verifiedPid(_ pid: Int) -> String {
        String(localized: "Verified pid \(String(pid))", bundle: .module)
    }

    /// A dropped message, by its outcome.
    public static func droppedText(_ message: PeerMessage) -> String {
        let name = message.senderName
        switch message.outcome {
        case "refused": return String(localized: "Declined the message from \(name)", bundle: .module)
        case "expired":
            return String(localized: "The message from \(name) expired — ask that session to send it again", bundle: .module)
        case "discarded":
            return String(localized: "The session ended, so the message from \(name) was not delivered", bundle: .module)
        case let other?:
            return String(localized: "The message from \(name) was not delivered (\(other))", bundle: .module)
        case nil:
            return String(localized: "The message from \(name) was not delivered", bundle: .module)
        }
    }

    /// `unprompted: true` (an older CLI delivered it without holding it): its card-type row.
    public static var unpromptedHeader: String {
        String(localized: "Message from another session — Claude read it without a request (changes were blocked)", bundle: .module)
    }

    public static var handleThisMessage: String { String(localized: "Handle this message", bundle: .module) }

    /// wave2 check-clients: the fallback row's button once its message went out (or was queued) as the user's own.
    public static var sentAsYourMessage: String { String(localized: "Sent as your message", bundle: .module) }

    /// What "Handle this message" sends: a normal `send` (the gate rules apply).
    public static func unpromptedSendText(_ message: PeerMessage) -> String {
        String(localized: "Message from another session (\(message.senderName)):", bundle: .module) + "\n" + (message.body ?? "")
    }

    // MARK: External turn (`state.session.externalTurn`)

    /// The composer while a turn that is not ours runs.
    public static func externalTurnComposer(_ turn: ExternalTurn) -> String {
        turn.peer != nil
            ? String(localized: "Handling another session's message — what you send goes out when it is done", bundle: .module)
            : String(localized: "Claude Code is busy with other work — what you send goes out when it is done", bundle: .module)
    }

    /// Why queued messages wait (`gate_closed:external_turn` included).
    public static var waitForExternalTurn: String { String(localized: "Sent once the other work is done", bundle: .module) }

    // MARK: Refusals

    /// The §29 refusal codes (and `gate_closed:external_turn`) in the user's words; nil = not one of them.
    public static func refusal(code: String, detail: String) -> String? {
        switch code {
        case "peer_none": return String(localized: "There is no message from another session to handle", bundle: .module)
        case "peer_inbox_changed": return inboxChanged
        case "peer_unsupported":
            return String(localized: "This Claude Code version does not support messages from other sessions", bundle: .module)
        case "peer_release_failed": return SessionNotices.peerReleaseFailedText
        case "peer_dismiss_failed":
            return String(localized: "The messages from other sessions could not be declined — try again", bundle: .module)
        case "invalid_peer_mode": return String(localized: "Unknown setting for messages from other sessions", bundle: .module)
        case "gate_closed" where detail == "external_turn": return waitForExternalTurn
        default: return nil
        }
    }

    // MARK: Attention

    public static func notificationBody(from name: String) -> String { sentMessage(from: name) }
}

public extension AttentionEvent {
    /// §29: a held message arrived while the window was in the background.
    static func peerMessage(_ message: PeerMessage) -> AttentionEvent {
        AttentionEvent(kind: .peerMessage,
                       title: String(localized: "Message from another session", bundle: .module),
                       body: PeerText.notificationBody(from: message.senderName),
                       key: "peer:\(message.id)")
    }
}
