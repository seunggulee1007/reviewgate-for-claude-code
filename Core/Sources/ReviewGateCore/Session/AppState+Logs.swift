import Foundation

// MARK: wave1 mac-session
// Audit robustness-03 ①② / crash-6 on the window: the stderr twin of a `log` event is dropped, every log line also goes
// to the daily file (masked there), and "진단 정보 복사" collects what a bug report needs.

public extension AppState {
    /// A `log` event or a stderr line: the stderr copy of an event is dropped (robustness-03 ②), the rest is logged.
    internal func ingestLog(level: LogLevel, message: String) {
        for line in logDeduper.ingest(level: level, message: message, now: Date()) { appendLog(line) }
        scheduleLogFlushIfNeeded()
    }

    private func scheduleLogFlushIfNeeded() {
        guard logDeduper.hasPending, !logFlushScheduled else { return }
        logFlushScheduled = true
        let delay = logDeduper.window + 0.1
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self else { return }
            self.logFlushScheduled = false
            for line in self.logDeduper.flush(now: Date()) { self.appendLog(line) }
            self.scheduleLogFlushIfNeeded()
        }
    }

    /// Every in-app log line also goes to the daily file (masked there), tagged with the window's project.
    internal func writeLogFile(_ line: String) {
        fileLog?.write(line, tag: projectName.isEmpty ? "app" : projectName)
    }

    /// "진단 정보 복사": versions, the state, the last error and the last 200 log lines, masked.
    func diagnosticsReport(appVersion: String, osVersion: String = ProcessInfo.processInfo.operatingSystemVersionString) async -> String {
        let engineVersion = await client.engineVersion
        let node = await toolchain?.nodeVersion()
        let claude = state.toolchain.claudeVersion.map { version in state.toolchain.claude.map { "\(version) (\($0))" } ?? version }
        return EngineDiagnostics(
            app: appVersion,
            engine: engineVersion,
            claude: claude ?? state.toolchain.claude,
            node: node.map { version in toolchain?.nodePath.map { "\(version) (\($0))" } ?? version },
            os: osVersion,
            logFolder: (fileLog?.directory ?? EngineLogFile.defaultDirectory).path,
            state: diagnosticsState,
            lastError: diagnosticsLastError,
            recentLog: Array(logs.suffix(200))).text()
    }

    private var diagnosticsState: [String] {
        let s = state
        var lines = [
            "project: \(s.project?.path ?? "-") · branch \(s.project?.branch ?? "-")",
            "session: open \(s.session.open) · starting \(s.session.starting) · ready \(s.session.ready.map(String.init) ?? "-") · id \(s.session.sessionId ?? "-") · model \(s.session.model ?? "-") · mode \(s.session.permissionMode.rawValue)",
            "gate: \(s.gate.phase.rawValue) · canSend \(s.gate.canSend) · blocked \(s.gate.blockedReason?.rawValue ?? "-") · pending \(s.gate.pendingCount) · changesRequested \(s.gate.changesRequestedCount) · collectError \(s.gate.collectError ?? "-")",
            "peer: \(s.session.peerInbound?.rawValue ?? "-") · inbox \(s.session.peerInbox.count) · externalTurn \(s.session.externalTurn == nil ? "no" : "yes")",
            "permission: \(s.session.pendingPermission?.toolName ?? "-") · plan \(s.session.pendingPlan == nil ? "no" : "yes")",
            "queue: \(queuedMessages.count) · paused \(queuePausedReason ?? "-")",
            "chats: \(sessions.count) · current \(currentSessionId ?? "-")",
        ]
        if let engineError = s.lastError { lines.append("engine lastError: \(engineError)") }
        return lines
    }

    private var diagnosticsLastError: [String] {
        if let banner = errorBanner {
            var lines = ["code: \(banner.code ?? "-") · scope \(banner.scope.rawValue) · fatal \(banner.fatal) · ×\(banner.repeatCount)",
                         "message: \(banner.message)"]
            if let secondary = banner.secondary { lines.append("detail: \(secondary)") }
            return lines
        }
        for item in transcript.reversed() {
            if case let .error(_, message, fatal, info) = item {
                var lines = ["code: \(info.code ?? "-") · fatal \(fatal) · ×\(info.count)", "message: \(message)"]
                if let secondary = info.secondary { lines.append("detail: \(secondary)") }
                return lines
            }
        }
        return []
    }
}
