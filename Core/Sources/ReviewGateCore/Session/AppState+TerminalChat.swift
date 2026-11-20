import Foundation

// MARK: terminal-chat (§57)
// docs/PROTOCOL.md §57.5: a terminal chat's column is the real Claude Code TUI. The engine gates its turns through hooks;
// this side opens the chat (held like ⌘T while Claude works), asks for the spec the App's PTY runs, reports the PTY's
// start and exit, ends a turn Esc left open ("Review now"), raises the TUI's waits as attention, and routes Stop (⌘.) to
// the PTY (Esc) instead of the engine.

extension AppState {
    /// What chat `id` runs (`.chat` for an unknown id).
    public func chatKind(id: String?) -> SessionKind {
        guard let id else { return .chat }
        return sessions.first { $0.id == id }?.kind ?? .chat
    }

    /// What the live chat runs.
    public var currentChatKind: SessionKind { chatKind(id: currentSessionId) }

    /// The live chat is a terminal chat: the engine refuses the chat-only commands (`terminal_chat`).
    public var isTerminalChat: Bool { currentChatKind == .terminal }

    /// The chat on screen (the live one, or one shown read-only) is a terminal chat: the column shows its terminal.
    public var shownChatIsTerminal: Bool { chatKind(id: shownChatId) == .terminal }

    /// The live terminal chat's hook link (nil for a chat-kind chat).
    public var terminalInfo: TerminalSessionInfo? { isTerminalChat ? sessionInfo.terminal : nil }

    /// Claude Code waits for the user in the live terminal chat's TUI (a permission prompt, a question).
    public var terminalWaiting: TerminalWaiting? { terminalInfo?.waiting }

    /// ⌃⌘T / "New Terminal Chat": a fresh terminal chat — held while Claude works, as ⌘T is (`PendingChatSwitch`).
    @discardableResult
    public func newTerminalChat() async -> Bool {
        guard projectInfo != nil else { return false }
        if newChatBlocker == nil, chatSwitchWaits {
            holdChatSwitch(.newTerminalChat)
            return true
        }
        return await switchSession(.sessionNewTerminal)
    }

    /// `terminal_spec`: how to start `claude` for terminal chat `sessionId` (a fresh hook token each call). Throws the
    /// engine's refusal (`terminal_cli_too_old`, `terminal_hooks_disabled`, `cli_not_found`, …).
    public func terminalSpec(sessionId: String) async throws -> TerminalSpec {
        let reply = try await reply(.terminalSpec(sessionId: sessionId))
        guard case let .terminalSpec(spec) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return spec
    }

    /// The PTY runs `claude` for `sessionId` (its pid, so the engine never counts it as another Claude).
    public func terminalStarted(sessionId: String, pid: Int32) {
        reportTerminal(.terminalStarted(sessionId: sessionId, pid: pid))
    }

    /// The PTY of `sessionId` ended (nil: by a signal); the engine ends an open turn.
    public func terminalExited(sessionId: String, exitCode: Int32?) {
        reportTerminal(.terminalExited(sessionId: sessionId, exitCode: exitCode))
    }

    /// A PTY report the user did nothing for: a refusal (the chat was switched away meanwhile — the engine retired that
    /// terminal already) is only logged, never an error row.
    private func reportTerminal(_ command: EngineCommand) {
        if let commandSink { commandSink(command); return }
        Task {
            do { try await request(command) } catch { appendLog("[warn] \(command.type): \(error.localizedDescription)") }
        }
    }

    /// "Review now": ends the turn Esc left open. A refusal (`no_turn`: it closed meanwhile) becomes a non-fatal row.
    public func endTerminalTurn() async {
        guard let id = currentSessionId, isTerminalChat else { return }
        do {
            try await request(.terminalEndTurn(sessionId: id))
        } catch {
            appendLog("[warn] terminal_end_turn: \(error.localizedDescription)")
            if (error as? EngineClientError)?.refusalCode != "no_turn" { fail(FlowText.refusal(error), fatal: false) }
        }
    }

    /// After every snapshot: a wait that appeared in a terminal chat of this window — the live one, or one in the background
    /// (§57.10) — and a permission dialog the app may answer (§57.15) are attention events, once each. While a dialog can
    /// be answered from the app its own key (`termperm:`) stands for the chat's permission wait, so it is not raised twice.
    func terminalSnapshotApplied() {
        var events: [AttentionEvent] = []
        if isTerminalChat, let chat = currentSessionId {
            let permissions = terminalPermissions
            events += permissions.map { AttentionEvent.terminalPermission($0, chatId: chat) }
            if let waiting = terminalWaiting, permissions.isEmpty || waiting.kind != .permission {
                events.append(.terminalWaiting(waiting, chatId: chat))
            }
        }
        for background in sessionsInfo?.backgroundTerminals ?? [] where background.chatId != currentSessionId {
            guard let waiting = background.waiting else { continue }
            var event = AttentionEvent.terminalWaiting(waiting, chatId: background.chatId)
            event.chatId = background.chatId
            events.append(event)
        }
        let keys = Set(events.map(\.key))
        for event in events where !raisedTerminalWaitKeys.contains(event.key) { onAttention?(event) }
        raisedTerminalWaitKeys = keys
    }

    // MARK: terminal-stage2 (§57.10–57.15)

    /// §57.10: chat `id`'s Claude Code keeps running in the background of this window (nil: it does not).
    public func backgroundTerminal(chatId id: String?) -> BackgroundTerminalInfo? {
        guard let id else { return nil }
        return sessionsInfo?.backgroundTerminal(id)
    }

    /// §57.10: background terminal chats that wait for the user in their TUI (the tabs' bell, the Dock's "!").
    public var backgroundTerminalsWaiting: [BackgroundTerminalInfo] {
        (sessionsInfo?.backgroundTerminals ?? []).filter { $0.waiting != nil && $0.chatId != currentSessionId }
    }

    /// §57.14: a turn of the live terminal chat runs and notes wait — Request changes is staged for that turn's
    /// Stop (`via: "stop"`); the gate's own `canRequestChanges` is false while a turn runs.
    var terminalTurnTakesRequest: Bool {
        guard isTerminalChat, viewingChat == nil, gatePhase == .running, terminalInfo?.running == true else { return false }
        return !unsentNotes.isEmpty && gate.collectError == nil
    }

    /// §57.15: the live terminal chat's permission dialogs the app may answer, oldest first.
    public var terminalPermissions: [TerminalPermission] { terminalInfo?.permissions ?? [] }

    /// §57.15: [허용] / [거부] / [허용하고 따라가기] on a terminal chat's permission card. The TUI may have answered first: then the
    /// engine refuses `permission_gone` and the card is simply gone with the next snapshot (logged, no error row).
    public func terminalPermissionResponse(requestId: String, allow: Bool, message: String? = nil, follow: Bool = false) {
        guard let id = currentSessionId, isTerminalChat else { return }
        sendTerminalAnswer(.terminalPermissionResponse(sessionId: id, requestId: requestId, allow: allow, message: message,
                                                       follow: follow),
                           quiet: ["permission_gone"])
    }

    /// §57.14: [취소] on a queued Request changes — the notes stay unsent. Nothing queued any more is only logged.
    public func terminalRequestCancel() {
        guard let id = currentSessionId, isTerminalChat else { return }
        sendTerminalAnswer(.terminalRequestCancel(sessionId: id), quiet: ["no_request_queued"])
    }

    /// §57.14: [붙여넣기] on a queued Request changes — a fixed prompt goes into the TUI (bracketed paste, never Enter).
    @discardableResult
    public func pasteRequestChangesPrompt() -> String? {
        pasteIntoTerminal(TerminalStage2Text.requestChangesPrompt)
    }

    /// `set_settings {terminalPermissionBridge}` after Settings changed it (live).
    public func pushTerminalPermissionBridge() {
        guard state.seq > 0 || commandSink != nil else { return }
        var settings = EngineSettings()
        settings.terminalPermissionBridge = AppSettings.terminalPermissionBridge(defaults: settingsDefaults)
        fire(.setSettings(settings))
    }

    /// A click's command: a refusal in `quiet` (the state moved on meanwhile) is only logged, any other is a non-fatal row.
    private func sendTerminalAnswer(_ command: EngineCommand, quiet: Set<String>) {
        if let commandSink { commandSink(command); return }
        Task {
            do {
                try await request(command)
            } catch {
                appendLog("[warn] \(command.type): \(error.localizedDescription)")
                if let code = (error as? EngineClientError)?.refusalCode, quiet.contains(code) { return }
                fail(FlowText.refusal(error), fatal: false)
            }
        }
    }
}

extension AppSettings.Key {
    /// §57.15: answer Claude Code's permission dialogs from the app too; unset → true.
    public static let terminalPermissionBridge = "terminalPermissionBridge"
}

extension AppSettings {
    public static func terminalPermissionBridge(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.terminalPermissionBridge) as? Bool ?? true
    }
}

/// §57.10–57.15 in the user's words.
public enum TerminalStage2Text {
    /// §57.14: what [붙여넣기] pastes into the TUI (English: Claude Code reads it as the user's prompt).
    public static let requestChangesPrompt = "Please make the changes requested in the review notes."
}

extension AttentionEvent {
    /// §57.5: Claude Code waits in a terminal chat's TUI — "허용이 필요해요" / "Claude가 질문했어요" over its message (both block
    /// Claude, so the dock shows "!").
    public static func terminalWaiting(_ waiting: TerminalWaiting, chatId: String) -> AttentionEvent {
        let title = switch waiting.kind {
        case .permission: String(localized: "Permission needed in the terminal", bundle: .module)
        case .question: String(localized: "Claude asked a question in the terminal", bundle: .module)
        }
        return AttentionEvent(kind: waiting.kind == .permission ? .permission : .question, title: title,
                              body: clip(waiting.message, 160), key: "term:\(chatId):\(waiting.since)")
    }

    /// §57.15: a permission dialog of a terminal chat the app may answer — "허용이 필요해요" over its summary (and ReviewGate's
    /// own reason when it asked first).
    public static func terminalPermission(_ permission: TerminalPermission, chatId: String) -> AttentionEvent {
        let summary = clip(permission.summary, 160)
        let body = permission.reason.map { "\(summary.isEmpty ? permission.toolName : summary) — \(clip($0, 120))" }
            ?? (summary.isEmpty ? permission.toolName : summary)
        var event = AttentionEvent(kind: .permission, title: String(localized: "Permission needed in the terminal", bundle: .module),
                                   body: body, key: "termperm:\(chatId):\(permission.requestId)")
        event.requestId = permission.requestId
        return event
    }

    /// §57.15: a terminal chat's bridged permission dialog — its notification offers Allow / Deny.
    public var isTerminalPermission: Bool { key.hasPrefix("termperm:") && requestId != nil }
}

/// §57.15: the Allow / Deny actions on a terminal permission's notification (`UNNotificationCategory`).
public enum TerminalPermissionNotification {
    public static let category = "terminalPermission"
    public static let allowAction = "terminalPermission.allow"
    public static let denyAction = "terminalPermission.deny"

    /// `allow` for an action of this category (nil: the notification itself was clicked, or another action).
    public static func answer(actionIdentifier: String) -> Bool? {
        switch actionIdentifier {
        case allowAction: true
        case denyAction: false
        default: nil
        }
    }

    public static var allowTitle: String { String(localized: "Allow Once", bundle: .module) }
    public static var denyTitle: String { String(localized: "Deny", bundle: .module) }
}

/// §57.1: the engine's refusals of a terminal chat, in the user's words.
public enum TerminalChatText {
    public static func refusal(code: String) -> String? {
        switch code {
        case "terminal_chat":
            String(localized: "This chat runs Claude Code in a terminal — do it there", bundle: .module)
        case "terminal_unsupported":
            String(localized: "Terminal chats need the Mac app", bundle: .module)
        case "terminal_not_current":
            String(localized: "This terminal chat is not the live chat anymore — continue in it first", bundle: .module)
        case "terminal_cli_too_old":
            String(localized: "Terminal chats need Claude Code 2.1.295 or later — update it with `claude update`", bundle: .module)
        case "terminal_hooks_disabled":
            String(localized: "Hooks are turned off in your Claude Code settings (disableAllHooks or allowManagedHooksOnly), so ReviewGate cannot review a terminal chat", bundle: .module)
        case "no_turn":
            String(localized: "No turn is open — there is nothing to review yet", bundle: .module)
        // MARK: terminal-stage2
        case "permission_gone":
            String(localized: "That permission request was already answered in the terminal", bundle: .module)
        case "no_request_queued":
            String(localized: "No change request is waiting for Claude", bundle: .module)
        case "follow_not_allowed":
            String(localized: "Only a request to enter a worktree can be followed", bundle: .module)
        case "chat_is_record":
            String(localized: "This chat is read-only here — it moved or goes on in another chat", bundle: .module)
        default:
            nil
        }
    }
}
