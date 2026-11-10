import Foundation

// MARK: r2-review-flow — reviewing without extra clicks or modal stops (release 2) on the Mac: the rules both the views and
// the tests read.
// · M27: an open permission card sits above the composer; in the transcript every card is one line.

// MARK: - M27 a permission card in the transcript is one line

/// r2-review-flow M27: an open permission card sits above the composer (as Claude's question does, M08); in the transcript every
/// card is one line — "허용함 · Bash git commit -m …" — that opens to the whole card. Five answered cards no longer push
/// Claude's report off a 637 pt window.
public enum PermissionLineText {
    public enum Status: Sendable, Equatable { case waiting, allowed, denied, sent, notSent, handled }

    /// The line's state: waiting while open; else this client's answer, or "handled" (a rule, a withdrawal, the turn's end).
    public static func status(request: PermissionRequest, decision: Bool?, isOpen: Bool) -> Status {
        let sendMessage = request.toolName == "SendMessage"
        switch decision {
        case true?: return sendMessage ? .sent : .allowed
        case false?: return sendMessage ? .notSent : .denied
        case nil: return isOpen ? .waiting : .handled
        }
    }

    /// What the call is, on one line: the command's first line (Bash), the file (edit tools), else the readable call name.
    public static func call(_ request: PermissionRequest) -> String {
        if let command = request.input["command"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !command.isEmpty {
            let first = command.split(whereSeparator: \.isNewline).first.map(String.init) ?? command
            return "\(request.toolName) \(first)\(command.contains(where: \.isNewline) ? " …" : "")"
        }
        if let file = request.file, !file.isEmpty { return "\(request.toolName) \(file)" }
        return AgentGlance.callTitle(request.toolName, input: request.input)
    }

    /// "허용함 · Bash git commit -m …".
    public static func text(request: PermissionRequest, decision: Bool?, isOpen: Bool) -> String {
        let call = call(request)
        switch status(request: request, decision: decision, isOpen: isOpen) {
        case .waiting: return String(localized: "Waiting for your answer below · \(call)", bundle: .module)
        case .allowed: return String(localized: "Allowed · \(call)", bundle: .module)
        case .denied: return String(localized: "Denied · \(call)", bundle: .module)
        case .sent: return String(localized: "Sent · \(call)", bundle: .module)
        case .notSent: return String(localized: "Not sent · \(call)", bundle: .module)
        case .handled: return String(localized: "Handled · \(call)", bundle: .module)
        }
    }

    /// The line's tooltip: what a click does.
    public static func help(status: Status) -> String {
        status == .waiting ? String(localized: "The card waits above the message box — click to bring it into view", bundle: .module)
            : String(localized: "Click to show the whole card", bundle: .module)
    }
}
