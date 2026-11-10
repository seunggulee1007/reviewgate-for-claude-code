import Foundation

// MARK: wave4 w4-safety

/// polish-12: what one chat's composer holds — kept per chat so switching tabs never carries text into another chat.
public struct ChatDraft: Sendable, Equatable {
    public var text: String
    public var mentions: [String]
    public var images: [ComposerImage]

    public init(text: String = "", mentions: [String] = [], images: [ComposerImage] = []) {
        self.text = text
        self.mentions = mentions
        self.images = images
    }

    public var isEmpty: Bool { text.isEmpty && mentions.isEmpty && images.isEmpty }
}

extension AppState {
    // MARK: daily-14 — the stop reason of a turn

    /// Records what an `error` event says about the running turn. True when the event's own notification waits for the
    /// turn's end (the "finished" notification will carry the reason instead).
    func noteTurnStop(message: String, fatal: Bool, detail: EngineErrorDetail) -> Bool {
        let phase = state.gate.phase
        guard phase == .running || phase == .collecting else { return false }
        guard let reason = TurnStopReason.from(code: detail.code, message: message, detail: detail, fatal: fatal) else { return false }
        turnStopReason = TurnStopReason.merge(turnStopReason, reason)
        return TurnStopReason.defersNotification(code: detail.code, fatal: fatal)
    }

    /// The "turn finished" notification of the turn that just ended (its stop reason taken); nil when a fatal error of
    /// this turn was already posted on its own.
    func turnFinishedAttention(pending: Int, key: String) -> AttentionEvent? {
        let stopped = turnStopReason
        turnStopReason = nil
        if stopped?.alreadyNotified == true { return nil }
        return .turnFinished(pending: pending, key: key, stopped: stopped)
    }

    // MARK: robustness-07 — a stop that does not stop

    /// How long a turn may keep running after "Stop" before "Force restart" is offered.
    nonisolated public static let stuckInterruptDelay: Duration = .seconds(10)

    /// "Force restart" is offered: the turn ignored "Stop" for `stuckInterruptDelay` and still runs.
    public var showsForceRestart: Bool { interruptStuck && isRunning }

    /// Starts (or restarts) the watch after "Stop": once the delay passes with the turn still running, `interruptStuck`;
    /// it clears by itself when the turn ends.
    func armInterruptWatch(delay: Duration = AppState.stuckInterruptDelay) {
        interruptWatch?.cancel()
        interruptStuck = false
        interruptWatch = Task { [weak self] in
            try? await Task.sleep(for: delay)
            while !Task.isCancelled {
                guard let self else { return }
                let stuck = self.isRunning
                if self.interruptStuck != stuck { self.interruptStuck = stuck }
                if !stuck { return }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    /// "Force restart": the CLI process is ended and the same conversation is resumed (`restart_session` closes the
    /// running turn and collects its changes first); the queue and the review stay as they are.
    public func forceRestartStuckTurn() {
        guard showsForceRestart else { return }
        interruptWatch?.cancel()
        interruptStuck = false
        fire(.restartSession)
    }

    // MARK: polish-12 — a draft per chat

    /// The chat id drafts are kept under — the engine's chat (`state.sessions.currentId`); nil on engines without it,
    /// which keep the one window draft as before. wave4b w4b-tabs (§39.2): a chat shown read-only has its own draft.
    public var draftChatId: String? { sessionsInfo == nil ? nil : (viewingChat?.id ?? sessionsInfo?.currentId) }

    /// Keeps `draft` for chat `id` (an empty draft forgets it).
    public func stashDraft(_ draft: ChatDraft, for id: String?) {
        guard let id else { return }
        chatDrafts[id] = draft.isEmpty ? nil : draft
    }

    /// The draft kept for chat `id` (taken: the composer owns it again); empty when there is none.
    public func takeDraft(for id: String?) -> ChatDraft {
        guard let id else { return ChatDraft() }
        return chatDrafts.removeValue(forKey: id) ?? ChatDraft()
    }
}
