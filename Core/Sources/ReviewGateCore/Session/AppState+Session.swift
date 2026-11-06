import Foundation

// MARK: wave1 mac-session
// The client side of docs/PROTOCOL.md §30 (session start and recovery) and §29's external turn: `send` as request/reply
// (handoff M7), the queue rules of the notices (M4 / §2.9), merged error rows carrying the CLI's own words, the session
// banners and `ready`.

public extension AppState {
    // MARK: M7 — send as request/reply

    /// One message out as request/reply. Accepted → the turn starts (the queue's in-flight mark clears once it runs).
    /// Refused `gate_closed:*` — an external turn started (§29), the session restarts, … — → back to the front of the
    /// queue, which keeps running and sends it once the gate opens again. Any other refusal or a transport failure → back
    /// to the front, with the queue stopped and the reason shown.
    internal func deliver(_ message: QueuedMessage, acceptPending: Bool) {
        let accepting = acceptPending && canAcceptAndSend
        guard accepting || canSend else { return }
        recordPrompt(message.text)
        seedAttachments(message.images)
        let command = message.sendCommand(acceptPending: accepting)   // wave5 w5-model (§43.4: `.send`, or with this message's model)
        recentSend = (message, Date())
        if requestSink == nil, let commandSink { commandSink(command); return }
        Task { await sendRequest(command, message: message) }
    }

    internal func sendRequest(_ command: EngineCommand, message: QueuedMessage) async {
        do {
            try await request(command)
        } catch let error as EngineClientError where error.refusalCode == "gate_closed" {
            forgetRecentSend(message)
            requeueFront(message)
            queuedSendInFlight = false
            // A snapshot newer than this one says the gate opened again (no resend into the same closed gate).
            queueWaitsAfterSeq = state.seq
            appendLog("[info] send waits for the gate: \(error.localizedDescription)")
        } catch {
            forgetRecentSend(message)
            requeueFront(message)
            let text = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
            pauseQueue(text)
            // §35.1: a send whose snapshot A failed is refused (no error event any more) — its banner and row keep the code,
            // like the event's did (lfs_missing: the install command; repeats merge on it).
            if let code = (error as? EngineClientError)?.refusalCode, code == "send_failed" || code == "lfs_missing" {
                recordFailure(text, fatal: false, scope: .git, detail: EngineErrorDetail(code: code))
            } else {
                fail(text, fatal: false)
            }
        }
    }

    /// Puts `message` back at the front of the queue (once).
    internal func requeueFront(_ message: QueuedMessage) {
        guard !queuedMessages.contains(where: { $0.id == message.id }) else { return }
        queuedMessages.insert(message, at: 0)
    }

    private func forgetRecentSend(_ message: QueuedMessage) {
        if recentSend?.message.id == message.id { recentSend = nil }
    }

    /// `send_failed` / `lfs_missing`: the message that just went out did not reach Claude — it goes back to the front of
    /// the queue (which stops on that error) instead of being lost. The error event and the send's reply race, so the
    /// message is remembered for a while after it went out.
    internal func requeueFailedSend(code: String?) {
        // wave2 check-clients: the send behind a "Stop & send" first (AppState.swift `requeueFailedSendBehindInterrupt`).
        if code == "send_failed" || code == "lfs_missing", requeueFailedSendBehindInterrupt() { return }
        guard code == "send_failed" || code == "lfs_missing", let recent = recentSend,
              Date().timeIntervalSince(recent.at) < 60 else { return }
        recentSend = nil
        requeueFront(recent.message)
    }

    /// `drainQueue`'s gate after a `gate_closed:*` refusal: true once a newer snapshot arrived.
    internal func queueGateReopened() -> Bool {
        guard let seq = queueWaitsAfterSeq else { return true }
        guard state.seq != seq else { return false }
        queueWaitsAfterSeq = nil
        return true
    }

    // MARK: §29 external turn

    /// A turn the CLI runs that is not ours (`state.session.externalTurn`): sending waits, typing is queued.
    var isExternalTurn: Bool { sessionInfo.externalTurn != nil }

    /// The composer's line while an external turn holds the gate.
    var externalTurnNotice: String? {
        guard let turn = sessionInfo.externalTurn, !canSend else { return nil }
        return PeerText.externalTurnComposer(turn)
    }

    /// Why queued messages wait during an external turn.
    internal var externalTurnQueueHold: String? { isExternalTurn ? PeerText.waitForExternalTurn : nil }

    // MARK: §30 session start

    /// The CLI is starting (spawned, not answering initialize yet): the HUD's "Claude Code 시작 중…".
    var isClaudeCodeStarting: Bool {
        guard projectInfo != nil, !needsGitInit else { return false }
        if sessionInfo.starting { return true }
        return sessionInfo.open && sessionInfo.ready == false
    }

    var claudeCodeStartingText: String { String(localized: "Starting Claude Code…", bundle: .module) }

    /// A chat the CLI could not resume (`resumeFailed`): opening it shows its rows, but what follows goes to a new chat.
    func isReadOnlyChat(id: String) -> Bool { sessions.first { $0.id == id }?.resumeFailed == true }

    /// The banner's / composer's "새 채팅" without waiting for the result (a refusal becomes an error row).
    func startNewChat() {
        errorBanner = nil
        Task { await newChat() }
    }

    /// "세션 종료됨 → 다시 연결" and the crash banner's "다시 연결" / "다시 시도": `restart_session` (the chat resumes).
    func reconnectSession() {
        if let banner = errorBanner, SessionNotices.isSessionDeath(code: banner.code, fatal: banner.fatal, scope: banner.scope) {
            errorBanner = nil
        }
        restartSession()
    }

    // MARK: §30 errors: merged rows, banners

    /// An error row — merged into the last one when the same error repeats (code + detail, else the text: ×N) — plus the
    /// banner with the code's actions. `detail` is the event's (nil for client-side failures); notices leave `lastError`.
    internal func recordFailure(_ text: String, fatal: Bool, scope: ErrorScope, detail: EngineErrorDetail?, engineMessage: String? = nil) {
        let code = detail?.code
        let notice = SessionNotices.isNotice(code: code, fatal: fatal)
        if !notice { lastError = text }
        let secondary = detail.flatMap { SessionNotices.secondaryLine(message: engineMessage ?? text, detail: $0) }
        var rows = transcript
        let restored = restoredTranscriptIDs
        // r1-scope (§33.4): a command's changes outside the review — the files on the row, its folder for the row's actions.
        var info = ScopeText.rowInfo(ErrorRowInfo(code: code, detail: detail?.detail, secondary: secondary, scope: scope, lastAt: Date()),
                                     detail: detail)
        info.quiet = LongWorkText.isQuietHookNotice(code: code, hookName: detail?.hookName)   // r1x (§38.2)
        let count = SessionNotices.appendError(
            to: &rows, message: text, fatal: fatal,
            info: info,
            mergeable: { !restored.contains($0) })
        transcript = rows
        var line = "[error] \(code.map { "\($0): " } ?? "")\(engineMessage ?? text)"
        if let secondary { line += " — \(secondary)" }
        appendLog(line)
        if code == "peer_release_failed", !state.session.peerInbox.isEmpty {
            // The peer card says it, right where the user acted (its buttons are the retry / decline).
            peerNotice = text
            return
        }
        // wave3 mac-session (§36.8): the CLI version's banner comes from `session.cli` (once per version); the notice is the row.
        if code == "cli_version_changed" { return }
        if LongWorkText.isRowOnly(code) { return }   // wave4 w4-longwork (§38.2): hook / CLI words are chat rows only
        if code == "auto_mode_unavailable" { noteAutoModeUnavailable() }   // wave6 w6-terminal (§44.1): shift+tab skips auto
        if AutoModeText.isRowOnly(code) { return }   // wave4b w4b-auto (§39.5): what auto mode blocked is a gray row
        if ScopeText.isRowOnly(code) { return }   // r1-scope (§33.4): what already ran outside the review is a row with its actions
        if GitNoticeText.isRowOnly(code) { return }   // r1-git (§46): what Claude's git commands did is a row
        var banner = ErrorBanner(message: text, scope: scope, fatal: fatal, code: code,
                                 actions: SessionNotices.bannerActions(code: code, repeats: count, path: detail?.path,
                                                                       pathIsWorkbench: isWorkbenchPath(detail?.path)))
        banner.secondary = secondary
        banner.repeatCount = count
        banner.sessionId = detail?.sessionId
        banner.toolName = detail?.toolName
        banner.path = detail?.path
        banner.branch = detail?.branch
        errorBanner = banner
    }

    /// The text and row info of a restored `kind: "error"` row (§30), worded like the live banner was.
    internal func restoredError(message: String, scope: ErrorScope, code: String?, detail: String?, at: String,
                                facts: EngineErrorDetail = EngineErrorDetail()) -> (text: String, info: ErrorRowInfo) {
        let full = SessionNotices.restoredDetail(code: code, detail: detail, message: message, facts: facts)
        let text = EngineMessages.error(message: message, detail: full)
        var info = ScopeText.rowInfo(ErrorRowInfo(code: code, detail: detail, secondary: SessionNotices.secondaryLine(message: message, detail: full),
                                                  scope: scope, lastAt: Self.isoDate(at)), detail: full)   // r1-scope (§33.4)
        info.quiet = LongWorkText.isQuietHookNotice(code: code, hookName: facts.hookName)   // r1x (§38.2)
        return (text, info)
    }

    /// `path` is one of the project's worktrees (`state.workbenches.list`).
    func isWorkbenchPath(_ path: String?) -> Bool {
        guard let path, !path.isEmpty else { return false }
        let key = URL(fileURLWithPath: path).standardizedFileURL.path
        return workbenches.list.contains { URL(fileURLWithPath: $0.path).standardizedFileURL.path == key }
    }

    internal static func isoDate(_ text: String) -> Date? {
        if let d = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        return try? Date(text, strategy: Date.ISO8601FormatStyle())
    }

    /// After every snapshot: a session that came back (`ready` false → true) clears its crash banner (§30); the peer card's
    /// notice goes with the last message; once a turn is over, a later `send_failed` (request changes, a rewind) is no longer
    /// about the message that started it.
    internal func sessionSnapshotApplied(previous: ReviewState) {
        if previous.session.ready == false, state.session.ready == true, let banner = errorBanner,
           SessionNotices.isSessionDeath(code: banner.code, fatal: banner.fatal, scope: banner.scope) {
            errorBanner = nil
        }
        if state.session.peerInbox.isEmpty { peerNotice = nil }
        let busy: (GatePhase) -> Bool = { $0 == .running || $0 == .collecting }
        if busy(previous.gate.phase) && !busy(state.gate.phase) || state.hud.turnCount != previous.hud.turnCount { recentSend = nil }
        // wave3 mac-session (§36.5): the app's own capability cache keeps this session's lists once the CLI answered — never
        // the placeholder a §36 engine reports while it starts (its cache or empty lists) nor a replayed cache.
        if let caps = state.session.capabilities, !caps.isStarting, !state.session.capabilitiesCached, caps != previous.session.capabilities {
            AppSettings.setCachedCapabilities(caps, defaults: settingsDefaults)
        }
    }

    /// What the window forgets when it opens / closes a project.
    internal func resetSessionExtras() {
        recentSend = nil
        queueWaitsAfterSeq = nil
        peerNotice = nil
        isPeerBusy = false
        handledUnpromptedPeerIds = []   // wave2 check-clients
        sessionTools.reset()   // wave3 mac-session: retry state, the closed banner, other sessions
    }
}

// MARK: - daily-03

/// What the "Changes" segment shows while another sidebar tab is in front (audit daily-03).
public enum ChangesTabStatus: Sendable, Equatable {
    case idle
    /// Claude is working (a turn, its collection, a revert, an external turn).
    case working
    /// Claude waits for the user: a permission card, a question, a plan, a message from another session.
    case waiting
    /// Files wait for review.
    case review(Int)
}

public extension AppState {
    /// The "Changes" segment's status while another tab is in front.
    var changesTabStatus: ChangesTabStatus {
        guard projectInfo != nil else { return .idle }
        // wave2 check-clients: in `auto` the engine takes a held message itself once Claude is idle — nothing waits for the user.
        let peerWaits = !heldPeerMessages.isEmpty && sessionInfo.peerInbound != .auto
        if pendingPermission != nil || pendingPlan != nil || peerWaits { return .waiting }
        if isRunning || isSnapshotting || isReverting || isExternalTurn { return .working }
        let pending = gate.pendingCount + gate.changesRequestedCount
        return pending > 0 ? .review(pending) : .idle
    }

    var claudeWaitingText: String { String(localized: "Claude is waiting for you — go back", bundle: .module) }
}
