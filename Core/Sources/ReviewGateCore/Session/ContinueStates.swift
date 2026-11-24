import Foundation

// MARK: continue-states — docs/PROTOCOL.md §58.1
// The Changes header's primary button follows the review: "Accept All & Continue" while nothing is decided, "Accept N More &
// Continue" once some files are, "Continue" when nothing is pending but Claude has not been told the decisions yet, and the
// change request while notes wait to be sent. Nothing pending and nothing to tell: no button (Commit… keeps its place).
// The composer's pending banner, ⌘⇧↩ in an empty message box and a terminal chat's strip run the same one.

/// `state.gate.untoldDecisions`: what the next message's review summary reports (nil: nothing, or an older engine).
public struct UntoldDecisions: Decodable, Sendable, Equatable {
    public var accepted: Int
    public var rejected: Int

    public init(accepted: Int, rejected: Int) {
        self.accepted = accepted
        self.rejected = rejected
    }

    private enum Keys: String, CodingKey { case accepted, rejected }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        accepted = ((try? c.decodeIfPresent(Int.self, forKey: .accepted)) ?? nil) ?? 0
        rejected = ((try? c.decodeIfPresent(Int.self, forKey: .rejected)) ?? nil) ?? 0
    }
}

enum UntoldDecisionsWire {
    private enum GateKeys: String, CodingKey { case untoldDecisions }

    static func info(from decoder: Decoder) -> UntoldDecisions? {
        guard let c = try? decoder.container(keyedBy: GateKeys.self) else { return nil }
        return (try? c.decodeIfPresent(UntoldDecisions.self, forKey: .untoldDecisions)) ?? nil
    }
}

/// What the primary button is for the review's state.
public enum ContinuePrimary: Equatable, Sendable {
    /// Files pending, none decided this round: "Accept All & Continue".
    case acceptAll(pending: Int)
    /// Some decided, these still pending: "Accept N More & Continue".
    case acceptRest(pending: Int)
    /// Nothing pending; the decisions go to Claude with "Continue.".
    case continueOnly
    /// Notes wait to be sent: "Request changes (N)".
    case requestChanges(notes: Int)
}

/// "수락 1개 · 거절 2개를 Claude에게 알려요" under "Continue": what the button tells Claude (nil: nothing to say).
public enum ContinueCaption {
    public static func text(_ untold: UntoldDecisions?) -> String? {
        guard let u = untold, u.accepted + u.rejected > 0 else { return nil }
        return String(localized: "Tells Claude: \(u.accepted) accepted · \(u.rejected) rejected", bundle: .module)
    }
}

public enum ContinueRules {
    /// The decision table. `decided`: a file of this review was accepted or rejected (told to Claude or not); `untold`: the
    /// next message would carry decisions. nil: no button.
    public static func primary(pending: Int, unsentNotes: Int, decided: Bool, untold: Bool) -> ContinuePrimary? {
        if unsentNotes > 0 { return .requestChanges(notes: unsentNotes) }
        if pending > 0 { return decided || untold ? .acceptRest(pending: pending) : .acceptAll(pending: pending) }
        return untold ? .continueOnly : nil
    }
}

extension AppState {
    /// Decisions the next message tells Claude: the engine's count, or (an older engine) its summary text.
    public var hasUntoldDecisions: Bool {
        if let untold = gate.untoldDecisions { return untold.accepted + untold.rejected > 0 }
        return gate.lastReviewSummary != nil
    }

    /// The Changes header's primary for the review on screen (nil: none).
    public var continuePrimary: ContinuePrimary? {
        ContinueRules.primary(pending: pendingFiles.count, unsentNotes: unsentNotes.count,
                              decided: changedFiles.contains { $0.state == .accepted }, untold: hasUntoldDecisions)
    }

    /// Why the primary is off (nil: on), with the reason the button shows.
    public var continuePrimaryBlocker: String? {
        switch continuePrimary {
        case nil: return nil
        case .acceptAll, .acceptRest: return acceptAllContinueBlocker
        case .continueOnly: return continueOnlyBlocker
        case .requestChanges: return requestChangesPrimaryBlocker
        }
    }

    /// "Continue" with nothing pending: a chat's send rule, a terminal chat's idle-at-its-prompt rule.
    var continueOnlyBlocker: String? {
        if viewingChat != nil { return AcceptAllContinueText.showRunningChat }
        if isTerminalChat { return terminalContinueBlocker }
        if !canSend { return cannotSendReason ?? String(localized: "Claude can't take a message right now", bundle: .module) }
        return nil
    }

    var requestChangesPrimaryBlocker: String? {
        if viewingChat != nil { return AcceptAllContinueText.showRunningChat }
        if !canRequestChanges { return cannotSendReason ?? String(localized: "Claude can't take a message right now", bundle: .module) }
        return nil
    }

    /// "⋯ › Continue, Leave the Rest Pending": why it is off (nil: on). Files must be pending (else the primary covers it),
    /// Claude must take a message, and §64 `prompts` must not hold it.
    public var continueLeavingRestBlocker: String? {
        guard !pendingFiles.isEmpty else { return TerminalFrictionText.nothingPending }
        if viewingChat != nil { return AcceptAllContinueText.showRunningChat }
        if reviewFirstHolds(AcceptContinueRules.message) { return ContinueText.reviewFirstHolds }
        if isTerminalChat { return terminalContinueBlocker }
        if !canSend { return cannotSendReason ?? String(localized: "Claude can't take a message right now", bundle: .module) }
        return nil
    }

    /// A chat's "Continue" (nothing pending) or "Continue, Leave the Rest Pending": a plain `send` of `Continue.` — the
    /// engine puts the review summary in front of it; nothing is accepted. False when it cannot go now.
    @discardableResult
    public func continueWithoutAccepting() -> Bool {
        let blocker = pendingFiles.isEmpty ? continueOnlyBlocker : continueLeavingRestBlocker
        guard blocker == nil, !isTerminalChat else { return false }
        send(AcceptContinueRules.message)
        return true
    }
}

/// §58.1 in the user's words.
public enum ContinueText {
    public static func title(_ primary: ContinuePrimary) -> String {
        switch primary {
        case .acceptAll: AcceptAllContinueText.title
        case let .acceptRest(pending): String(localized: "Accept \(pending) More & Continue", bundle: .module)
        case .continueOnly: String(localized: "Continue", bundle: .module)
        case let .requestChanges(notes): String(localized: "Request changes (\(notes))", bundle: .module)
        }
    }

    /// The ⋯ item: continue without deciding the pending files.
    public static var leaveRestTitle: String { String(localized: "Continue, Leave the Rest Pending", bundle: .module) }

    /// Why it is off under §64 `prompts`.
    public static var reviewFirstHolds: String {
        String(localized: "Settings › Review holds new messages until every file is accepted or rejected", bundle: .module)
    }

    /// The toast after "Continue".
    public static var continuedToast: String { String(localized: "Told Claude to continue", bundle: .module) }

    /// The toast after "Continue, Leave the Rest Pending".
    public static func leftPendingToast(_ pending: Int) -> String {
        String(localized: "Told Claude to continue — \(pending) file(s) still wait for review", bundle: .module)
    }
}
