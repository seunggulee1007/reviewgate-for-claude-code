import Foundation

// MARK: wave3 mac-session
// docs/PROTOCOL.md §36.9 on the client: the user's other Claude sessions in this repository (`cli_sessions` — the sidebar's
// "Other Claude sessions in this repository", refreshed while the window is in front), a terminal conversation imported as a
// new chat (`cli_session_import`; the review gate applies from then on) and "Continue in terminal" for this window's chats
// (`cd <folder> && claude --resume <id>`). Only the engine reads the registry; nothing is sent to the other processes.

public enum CliSessionText {
    /// The registry's state in the user's words; nil when the entry says none.
    public static func status(_ status: CliSessionStatus) -> String? {
        switch status {
        case .busy: String(localized: "Working", bundle: .module)
        case .waiting: String(localized: "Waiting for input", bundle: .module)
        case .idle: String(localized: "Idle", bundle: .module)
        case .unknown: nil
        }
    }

    /// `cd <folder> && claude --resume <id>`, both quoted for the shell when they need it.
    public static func resumeCommand(folder: String, sessionId: String) -> String {
        "cd \(shellQuoted(folder)) && claude --resume \(shellQuoted(sessionId))"
    }

    /// As is when every character is plain, else in single quotes (a `'` as `'\''`).
    static func shellQuoted(_ text: String) -> String {
        let plain = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./:@%+=,")
        if !text.isEmpty, text.unicodeScalars.allSatisfy(plain.contains) { return text }
        return "'" + text.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
    }

    /// A session's folder named after the worktree it is in (`acme-1600`, `acme/batch/module`); outside them, its
    /// last path component.
    public static func folder(_ cwd: String, worktrees: [String]) -> String {
        guard !cwd.isEmpty else { return "" }
        let path = standardized(cwd)
        let root = worktrees.map(standardized).filter { path == $0 || path.hasPrefix($0 + "/") }.max { $0.count < $1.count }
        guard let root else { return (path as NSString).lastPathComponent }
        let name = (root as NSString).lastPathComponent
        let rest = path.dropFirst(root.count).drop { $0 == "/" }
        return rest.isEmpty ? name : name + "/" + rest
    }

    /// The row's title: the session's name (`/rename`), else its folder.
    public static func title(_ session: CliRunningSession, worktrees: [String]) -> String {
        if let name = session.name { return name }
        let folder = folder(session.cwd, worktrees: worktrees)
        return folder.isEmpty ? "Claude" : folder
    }

    /// A refused import in the user's words; other codes keep the general refusal text.
    public static func importRefusal(code: String?, fallback: String) -> String {
        switch code {
        case "cli_session_running":
            String(localized: "This conversation is still open in a terminal — quit it there first: two Claude processes on one conversation would corrupt it.", bundle: .module)
        case "unknown_session":
            String(localized: "This conversation is no longer in the list — refresh and try again.", bundle: .module)
        default: fallback
        }
    }

    public static var importAlreadyRunning: String {
        String(localized: "An import is already running", bundle: .module)
    }

    private static func standardized(_ path: String) -> String {
        let p = URL(fileURLWithPath: path).standardizedFileURL.path
        return p.count > 1 && p.hasSuffix("/") ? String(p.dropLast()) : p
    }
}

public enum CliSessionList {
    /// This worktree's sessions first (their edits land in this window's review), then waiting for input, working, idle;
    /// the engine's order otherwise.
    public static func sorted(_ sessions: [CliRunningSession]) -> [CliRunningSession] {
        sessions.enumerated().sorted { a, b in
            if a.element.sameWorktree != b.element.sameWorktree { return a.element.sameWorktree }
            let ra = rank(a.element.status), rb = rank(b.element.status)
            return ra != rb ? ra < rb : a.offset < b.offset
        }.map(\.element)
    }

    private static func rank(_ status: CliSessionStatus) -> Int {
        switch status {
        case .waiting: 0
        case .busy: 1
        case .idle: 2
        case .unknown: 3
        }
    }
}

public extension AppState {
    /// The sidebar's other sessions in display order.
    var otherClaudeSessions: [CliRunningSession] { CliSessionList.sorted(sessionTools.running) }

    /// The folders sessions are named after: this repository's worktrees, else the project folder.
    var sessionFolderRoots: [String] {
        let list = workbenches.list.map(\.path)
        return list.isEmpty ? [projectInfo?.path].compactMap { $0 } : list
    }

    /// `cd <folder> && claude --resume <id>` for one of this window's chats — the CLI keys conversations by the folder the
    /// session runs in (the project folder). Nil while Claude Code has no record of it (nothing sent yet) or after it lost
    /// it (`resumeFailed`).
    func continueInTerminalCommand(for meta: SessionMeta) -> String? {
        guard let folder = projectInfo?.path, !meta.resumeFailed,
              meta.cliKnown || meta.turns > 0 || !meta.lastUserText.isEmpty else { return nil }
        return CliSessionText.resumeCommand(folder: folder, sessionId: meta.id)
    }

    /// Why "Import a CLI session" cannot run now: the refusals of opening a chat.
    var cliImportBlockedReason: String? { chatSwitchBlocker }

    /// The current chat came from a terminal session: "The review gate applies from here on".
    var currentImportedSession: ImportedSession? { sessions.first { $0.id == currentSessionId }?.imported }
}
