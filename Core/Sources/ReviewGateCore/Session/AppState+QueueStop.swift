import Foundation

// docs/PROTOCOL.md §50.1: an error stops the composer's queue only when it is about the message's own send, its session,
// a login or the API — a failing PR list, a refresh or a commit say so in their banner and the queue goes on. The API and
// the usage limit stop it for a while: it goes on by itself (30 s, then 2 min; a minute after the limit resets).

extension AppState {
    /// Every `error` that is not a notice (`handleError`): stops the queue as `stop` says.
    func stopQueue(_ stop: QueueStop, reason: String, detail: EngineErrorDetail, now: Date = Date()) {
        switch stop {
        case .none:
            return
        case .pause:
            pauseQueue(reason)
        case .retry:
            guard !queuedMessages.isEmpty || sendAfterInterrupt != nil else { return }
            queueRetries += 1
            pauseQueue(reason, resumesAt: now.addingTimeInterval(QueueStop.retryDelay(after: queueRetries)))
        case .untilLimitResets:
            pauseQueue(reason, resumesAt: detail.resetDate.map(LimitResume.dueDate(resetAt:)))
        }
    }

    /// Sets (or with nil drops) the time the stopped queue goes on by itself.
    func scheduleQueueResume(at date: Date?) {
        queueResumeTask?.cancel()
        queueResumeTask = nil
        queueResumesAt = date
        guard let date else { return }
        queueResumeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, date.timeIntervalSinceNow)))
            guard !Task.isCancelled else { return }
            self?.stepQueueResume(now: Date())
        }
    }

    /// The queue goes on once its time came — unless it was resumed, cleared or stopped again for good meanwhile.
    func stepQueueResume(now: Date) {
        guard let due = queueResumesAt, queuePausedReason != nil, now >= due else { return }
        resumeQueue()
    }
}
