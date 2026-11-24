import Foundation

// MARK: terminal-friction — docs/PROTOCOL.md §58 / §57.7
// A terminal chat's own "Accept N & Continue": the user's click accepts the pending files, then "Continue." goes into the
// TUI as one bracketed paste followed by Enter — the only Enter the app ever types, and only for that click. The engine
// adopts the prompt as usual: the review summary ("[Review gate] Accepted: …") goes to Claude as its additionalContext,
// as a chat's `send {acceptPending}` puts it in front of the message.

extension AppState {
    /// Why the terminal chat's "Accept N & Continue" is off (nil: on). Claude Code must be idle at its prompt — the turn
    /// ended, nothing collected or reverted, no dialog open — and the files pending with none sent back for changes.
    public var terminalAcceptContinueBlocker: String? {
        guard isTerminalChat, viewingChat == nil else { return NewChatKindText.notTerminal }
        guard !pendingFiles.isEmpty else { return TerminalFrictionText.nothingPending }
        if !changesRequestedFiles.isEmpty {
            return String(localized: "Send your change request (\(changesRequestedFiles.count) file(s)) to continue", bundle: .module)
        }
        return terminalContinueBlocker
    }

    /// MARK: continue-states (§58.1): why `Continue.` cannot be typed into the live terminal chat now (nil: it can) —
    /// Claude Code idle at its prompt: no turn running or adopted, nothing collected or reverted, no dialog open in the TUI.
    public var terminalContinueBlocker: String? {
        guard isTerminalChat, viewingChat == nil else { return NewChatKindText.notTerminal }
        if isRunning || terminalInfo?.promptId != nil { return TerminalFrictionText.turnRunning }
        if terminalWaiting != nil { return TerminalFrictionText.waitsInTerminal }
        if !canSend { return cannotSendReason ?? TerminalFrictionText.turnRunning }
        return nil
    }

    /// "Accept N & Continue" in the live terminal chat: checks the TUI can take a paste first (so nothing is accepted for a
    /// Continue that cannot go), accepts every pending file and waits for the engine, then pastes `Continue.` and presses
    /// Enter. Returns why it did not (nil: Claude continues).
    public func terminalAcceptAndContinue() async -> String? {
        await terminalContinue(accepting: true)
    }

    /// §58.1: `Continue.` pasted and Return — after accepting every pending file (`accepting`), or as it is (nothing pending
    /// and decisions to tell, or "Continue, Leave the Rest Pending"). The review summary goes as the prompt's context.
    public func terminalContinue(accepting: Bool) async -> String? {
        if let why = accepting ? terminalAcceptContinueBlocker : terminalContinueBlocker { return why }
        guard let submit = onTerminalSubmit else { return NewChatKindText.terminalNotRunning }
        if let why = terminalInputBlocker?() { return why }
        let chat = currentSessionId
        if accepting {
            do {
                try await request(.acceptAll)
            } catch {
                return FlowText.refusal(error)
            }
        }
        // The chat changed or a turn started while the accept was on its way: the accept stands, nothing is typed.
        guard currentSessionId == chat, isTerminalChat, viewingChat == nil, !isRunning else { return NewChatKindText.notTerminal }
        return submit(AcceptContinueRules.message)
    }
}

/// §58 in the user's words.
public enum TerminalFrictionText {
    public static var nothingPending: String {
        String(localized: "No file waits for review", bundle: .module)
    }
    public static var turnRunning: String {
        String(localized: "Claude Code is still working — this is offered once the turn ends", bundle: .module)
    }
    public static var waitsInTerminal: String {
        String(localized: "Claude Code waits for you in the terminal — answer it there first", bundle: .module)
    }
}
