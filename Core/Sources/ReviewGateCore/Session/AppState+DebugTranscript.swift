import Foundation

#if DEBUG
// The screenshot tour's transcript check (App/Debug/ScreenshotTour.swift): a turn's events as the engine sends them and the
// turn ending into a review, without a turn of the engine's.
public extension AppState {
    /// Engine events, handled as if the engine had sent them.
    func debugHandle(_ events: [EngineEvent]) { events.forEach(handle) }

    /// The gate as a snapshot reports it: `.running` while the turn works, `.reviewing` with `files` pending after it. The
    /// engine's next snapshot puts its own back.
    func debugShowGate(_ phase: GatePhase, files: [ChangedFile] = []) {
        var snapshot = state
        snapshot.gate.phase = phase
        snapshot.gate.pendingCount = files.count
        snapshot.changedFiles = files
        state = snapshot
    }
}
#endif
