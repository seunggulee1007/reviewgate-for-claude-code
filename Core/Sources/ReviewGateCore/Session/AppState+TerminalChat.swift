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
        fire(.terminalStarted(sessionId: sessionId, pid: pid))
    }

    /// The PTY of `sessionId` ended (nil: by a signal); the engine ends an open turn.
    public func terminalExited(sessionId: String, exitCode: Int32?) {
        fire(.terminalExited(sessionId: sessionId, exitCode: exitCode))
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

    /// After every snapshot: a wait that appeared in the live terminal chat is an attention event (once per wait).
    func terminalSnapshotApplied() {
        guard let waiting = terminalWaiting, let chat = currentSessionId else {
            lastTerminalWaitingKey = nil
            return
        }
        let event = AttentionEvent.terminalWaiting(waiting, chatId: chat)
        guard event.key != lastTerminalWaitingKey else { return }
        lastTerminalWaitingKey = event.key
        onAttention?(event)
    }
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
        default:
            nil
        }
    }
}
