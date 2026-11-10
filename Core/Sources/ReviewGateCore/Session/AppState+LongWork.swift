import Foundation

// MARK: wave4 w4-longwork
// docs/PROTOCOL.md §38.2: [이어서 계속] after the tool-call limit, the usage limit the HUD shows and "풀리면 이어서 하기".

public extension AppState {
    /// [이어서 계속]: "계속해" to this chat by the composer's queue rules — now when the session takes a message, else
    /// at the end of the queue.
    func continueWork() {
        let text = LongWorkText.continueMessage
        if canSend, !queuedSendInFlight, queuedMessages.isEmpty, queuePausedReason == nil {
            send(text)
        } else {
            enqueue(text)
        }
    }

    /// The reset of the usage limit in force (HUD chip, banner); nil = no limit now, or its end is unknown.
    var activeLimitReset: Date? {
        LimitResume.activeReset(rateLimits: hud.rateLimits, lastResetAt: longWork.limitResetAt, now: Date())
    }

    /// A usage limit is in force now (with or without a known reset).
    var isUsageLimited: Bool { activeLimitReset != nil || LimitResume.limitedWithoutTime(rateLimits: hud.rateLimits) }

    /// "풀리면 이어서 하기" can be turned on: a limit whose reset is known.
    var canArmLimitResume: Bool { activeLimitReset != nil }

    func toggleLimitResume() {
        if longWork.resumeArmed { cancelLimitResume() } else { armLimitResume() }
    }

    func armLimitResume() {
        guard let reset = activeLimitReset else { return }
        longWork.limitResetAt = reset
        longWork.resumeArmed = true
        longWork.idleSinceArmed = !(isRunning || isStarting)
        longWork.armedChatId = state.sessions?.currentId   // wave4b w4b-check4 (§40.1)
        scheduleLimitResume(at: LimitResume.dueDate(resetAt: reset))
    }

    func cancelLimitResume() {
        longWork.resumeArmed = false
        longWork.idleSinceArmed = false
        longWork.armedChatId = nil   // wave4b w4b-check4 (§40.1)
        limitResumeTask?.cancel()
        limitResumeTask = nil
    }
}

extension AppState {
    /// Every `error` event: a usage limit's reset (a new limit without one disarms the resume). The tool-call limit's
    /// OS notification is the turn's "finished" one, which says why it stopped (`TurnStopReason.maxTurns`).
    func noteLongWork(_ detail: EngineErrorDetail) {
        switch detail.code {
        case "usage_limit":
            if let reset = detail.resetDate {
                longWork.limitResetAt = reset
                if longWork.resumeArmed { scheduleLimitResume(at: LimitResume.dueDate(resetAt: reset)) }
            } else if longWork.resumeArmed {
                cancelLimitResume()
            }
        default:
            break
        }
    }

    /// After every snapshot: an armed resume fires once the session is idle past the reset, and a turn that is not its own
    /// (the user sent something, the queue went on) disarms it.
    func longWorkSnapshotApplied() {
        stepLimitResume(now: Date())
    }

    func stepLimitResume(now: Date) {
        guard longWork.resumeArmed else { return }
        // wave4b w4b-check4 (§40.1): "계속해" only to the chat that stopped at the limit.
        if LimitResume.leftChat(armed: longWork.armedChatId, current: state.sessions?.currentId) {
            cancelLimitResume()
            return
        }
        let running = isRunning || isStarting
        let idle = canSend && !queuedSendInFlight && pendingPermission == nil && pendingPlan == nil && !isAnsweringPlan
        switch LimitResume.step(longWork, running: running, idle: idle, now: now) {
        case .wait:
            if !running { longWork.idleSinceArmed = true }
        case .cancel:
            cancelLimitResume()
        case .fire:
            cancelLimitResume()
            fireLimitResume()
        }
    }

    /// "계속해" ahead of whatever waits in the queue; a queue the limit stopped goes on after it.
    private func fireLimitResume() {
        let message = QueuedMessage(text: LongWorkText.continueMessage)
        if queuePausedReason != nil || !queuedMessages.isEmpty {
            queuedMessages.insert(message, at: 0)
            resumeQueue()
        } else {
            send(message.text)
        }
    }

    func scheduleLimitResume(at due: Date) {
        limitResumeTask?.cancel()
        let delay = max(0, due.timeIntervalSinceNow)
        limitResumeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.stepLimitResume(now: Date())
        }
    }
}
