import Foundation

// MARK: terminal-continue — docs/PROTOCOL.md §57.9
// "Continue as Terminal Chat": a chat's Claude conversation goes on in a new terminal chat, so nothing is lost now that a
// new chat is a terminal chat by default. The engine stops the chat's CLI, makes the terminal chat (it resumes that
// conversation) and keeps the chat as a record that names it; this side offers it, says why it cannot, and shows the link.

extension AppState {
    /// Why chat `meta` cannot go on in a terminal chat now (nil: it can). A terminal chat is not offered at all.
    public func continueAsTerminalBlocker(_ meta: SessionMeta) -> String? {
        guard projectInfo != nil else { return EngineMessages.refusal(error: "no_project") }
        if meta.kind == .terminal { return ContinueTerminalText.refusal("not_a_chat") }
        if meta.resumeFailed || meta.movedTo != nil || meta.continuedIn != nil { return ContinueTerminalText.refusal("chat_is_record") }
        if !meta.cliKnown && meta.turns == 0 { return ContinueTerminalText.refusal("nothing_to_continue") }
        if hasPendingReview { return ContinueTerminalText.refusal("review_pending") }
        if let blocker = newChatBlocker { return blocker }
        if chatSwitchWaits || switchingChat { return ContinueTerminalText.busy }
        return nil
    }

    /// `session_continue_terminal {sessionId}`: the new terminal chat becomes the live one. A refusal becomes a non-fatal
    /// row in the user's words; false then.
    @discardableResult
    public func continueAsTerminalChat(id: String) async -> Bool {
        guard projectInfo != nil else { return false }
        replaceTranscriptOnRestore = true
        if let commandSink { commandSink(.sessionContinueTerminal(sessionId: id)); return true }
        do {
            _ = try await request(.sessionContinueTerminal(sessionId: id))
            await settle()
            return true
        } catch {
            replaceTranscriptOnRestore = false
            appendLog("[warn] session_continue_terminal: \(error.localizedDescription)")
            let code = (error as? EngineClientError)?.refusalCode
            fail(code.flatMap(ContinueTerminalText.refusalOrNil) ?? FlowText.refusal(error), fatal: false)
            return false
        }
    }

    /// The terminal chat the chat on screen goes on in (§57.9) — the bar over its record says so.
    public var shownChatContinuedIn: SessionMeta? {
        guard let id = shownChatId, let target = sessions.first(where: { $0.id == id })?.continuedIn else { return nil }
        return sessions.first { $0.id == target }
    }
}

/// §57.9 in the user's words.
public enum ContinueTerminalText {
    public static func refusal(_ code: String) -> String {
        refusalOrNil(code) ?? EngineMessages.refusal(error: code)
    }

    public static func refusalOrNil(_ code: String) -> String? {
        switch code {
        case "not_a_chat":
            String(localized: "This chat already runs Claude Code in a terminal", bundle: .module)
        case "chat_is_record":
            String(localized: "This chat is a record — its conversation went on elsewhere or could not be resumed", bundle: .module)
        case "nothing_to_continue":
            String(localized: "This chat has no Claude conversation yet — send a message first, or open a new terminal chat", bundle: .module)
        case "review_pending":
            String(localized: "Accept or reject the files in the review first — the terminal chat's review starts with its own first prompt", bundle: .module)
        case "session_busy":
            busy
        case "terminal_unsupported":
            TerminalChatText.refusal(code: code)
        default:
            nil
        }
    }

    public static var busy: String {
        String(localized: "Claude is working — continue in a terminal chat once the turn is over", bundle: .module)
    }

    /// The bar over the record: "Continued in terminal chat '<title>'".
    public static func continuedBanner(title: String) -> String {
        String(localized: "This conversation continues in the terminal chat '\(title)' — this chat is kept as a record", bundle: .module)
    }
}
