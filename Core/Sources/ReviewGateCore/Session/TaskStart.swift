import Foundation

// MARK: task-start — docs/PROTOCOL.md §63: the start screen of a project window (바로 시작 · 업무로 시작 · 대화로 열기) and
// "Start from a task": the task platform, the branch the task gets, where it starts and the first prompt. GitHub issues are
// read by the engine (`task_fetch`, `gh`); every other tracker is read by Claude through an MCP server the user picks — the
// app never calls a tracker and stores no token.

// MARK: - Settings

/// Where a project's tasks live.
public enum TaskPlatform: String, Codable, CaseIterable, Sendable, Identifiable {
    /// No tracker: the task's id or link goes into the prompt as it is.
    case none
    /// GitHub Issues, read with `gh issue view` (`task_fetch`).
    case github
    /// Jira, Linear or another tracker: Claude reads the task with the chosen MCP server.
    case jira, linear
    case mcp

    public var id: String { rawValue }

    /// The English key of its name.
    public var title: String {
        switch self {
        case .none: "None"
        case .github: "GitHub Issues"
        case .jira: "Jira"
        case .linear: "Linear"
        case .mcp: "Other (MCP server)"
        }
    }

    /// Claude reads the task through an MCP server (the app does not).
    public var readsThroughMcp: Bool { self == .jira || self == .linear || self == .mcp }
}

/// Where "Start from a task" starts: a new branch in this window, or a new workbench (its own folder and window).
public enum TaskStartLocation: String, Codable, CaseIterable, Sendable {
    case branch, workbench
}

/// The "Tasks" settings of a project (or the default every project without its own uses).
public struct TaskStartSettings: Codable, Equatable, Sendable {
    public var platform: TaskPlatform
    /// What the branch starts with (`feature/`; `{type}` becomes `fix` / `docs` / `chore` / `feature` from the labels).
    public var branchPrefix: String
    public var location: TaskStartLocation
    /// The MCP server Claude reads Jira / Linear / other tasks with ("" = none chosen).
    public var mcpServer: String
    /// The first prompt; nil = the built-in one (`TaskPrompt.defaultTemplate`).
    public var promptTemplate: String?

    public static let defaultPrefix = "feature/"
    public static let `default` = TaskStartSettings()

    public init(platform: TaskPlatform = .none, branchPrefix: String = TaskStartSettings.defaultPrefix,
                location: TaskStartLocation = .branch, mcpServer: String = "", promptTemplate: String? = nil) {
        self.platform = platform
        self.branchPrefix = branchPrefix
        self.location = location
        self.mcpServer = mcpServer
        self.promptTemplate = promptTemplate
    }

    private enum CodingKeys: String, CodingKey { case platform, branchPrefix, location, mcpServer, promptTemplate }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(platform: lenientValue(TaskPlatform.self, c, .platform) ?? .none,
                  branchPrefix: lenientValue(String.self, c, .branchPrefix) ?? Self.defaultPrefix,
                  location: lenientValue(TaskStartLocation.self, c, .location) ?? .branch,
                  mcpServer: lenientValue(String.self, c, .mcpServer) ?? "",
                  promptTemplate: lenientValue(String.self, c, .promptTemplate))
    }

    /// The template the prompt is made from.
    public var template: String { promptTemplate ?? TaskPrompt.defaultTemplate }
}

public extension AppSettings.Key {
    /// §63: JSON `TaskStartSettings` — the default of every project without its own.
    static let taskStartSettings = "taskStartSettings"
    /// §63: JSON `[projectKey: TaskStartSettings]` — a project's own (per repository: its main worktree).
    static let projectTaskStartSettings = "projectTaskStartSettings"
    /// §63 (Bool, default false): "다음부터 바로 시작" — a project window opens straight into its chat, no start screen.
    static let skipStartScreen = "skipStartScreen"
}

public extension AppSettings {
    /// The project's own Tasks settings, else the default.
    static func taskStartSettings(root: String?, defaults: UserDefaults = .standard) -> TaskStartSettings {
        if let root, let own = projectTaskStartTable(defaults)[root] { return own }
        return globalTaskStartSettings(defaults: defaults)
    }

    static func globalTaskStartSettings(defaults: UserDefaults = .standard) -> TaskStartSettings {
        guard let data = defaults.data(forKey: Key.taskStartSettings) else { return .default }
        return (try? JSONDecoder().decode(TaskStartSettings.self, from: data)) ?? .default
    }

    /// The project has settings of its own (else it uses the default).
    static func hasProjectTaskStartSettings(root: String, defaults: UserDefaults = .standard) -> Bool {
        projectTaskStartTable(defaults)[root] != nil
    }

    /// `root` nil: the default; else that project's own.
    static func setTaskStartSettings(_ settings: TaskStartSettings, root: String?, defaults: UserDefaults = .standard) {
        guard let root else {
            if let data = try? JSONEncoder().encode(settings) { defaults.set(data, forKey: Key.taskStartSettings) }
            return
        }
        var table = projectTaskStartTable(defaults)
        table[root] = settings
        if let data = try? JSONEncoder().encode(table) { defaults.set(data, forKey: Key.projectTaskStartSettings) }
    }

    /// The project goes back to the default.
    static func clearProjectTaskStartSettings(root: String, defaults: UserDefaults = .standard) {
        var table = projectTaskStartTable(defaults)
        guard table.removeValue(forKey: root) != nil else { return }
        if let data = try? JSONEncoder().encode(table) { defaults.set(data, forKey: Key.projectTaskStartSettings) }
    }

    static func skipStartScreen(defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: Key.skipStartScreen) }

    static func setSkipStartScreen(_ skip: Bool, defaults: UserDefaults = .standard) { defaults.set(skip, forKey: Key.skipStartScreen) }

    private static func projectTaskStartTable(_ defaults: UserDefaults) -> [String: TaskStartSettings] {
        guard let data = defaults.data(forKey: Key.projectTaskStartSettings) else { return [:] }
        return (try? JSONDecoder().decode([String: TaskStartSettings].self, from: data)) ?? [:]
    }
}

// MARK: - The task the user names

/// A task id or link as typed or pasted: `ACME-123`, `#42`, `42`, `owner/repo#42`, `https://tracker.example.com/task/123`,
/// `https://github.com/acme/widgets/issues/42`.
public struct TaskReference: Equatable, Sendable {
    /// What the user gave (trimmed).
    public var raw: String
    /// The id the branch and the prompt use (`ACME-123`, `42`).
    public var id: String
    /// The link, when one was given.
    public var url: String?
    /// What `task_fetch` takes when this is a GitHub issue (a number, `owner/repo#n`, an `/issues/<n>` link); nil otherwise.
    public var issueRef: String?
    /// An `/issues/<n>` link on a GitHub host (`github.com` or a host named `github.…` / `…github…`).
    public var isGitHubLink: Bool

    /// nil for nothing usable (empty, or no ASCII id in it).
    public static func parse(_ text: String) -> TaskReference? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let tokens = trimmed.split(whereSeparator: \.isWhitespace).map(String.init)
        let token = tokens.first { $0.hasPrefix("http://") || $0.hasPrefix("https://") } ?? tokens[0]
        if token.hasPrefix("http://") || token.hasPrefix("https://"), let url = URL(string: token), let host = url.host?.lowercased() {
            let parts = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
            if parts.count >= 4, parts[parts.count - 2] == "issues", let n = Int(parts[parts.count - 1]), n > 0 {
                let github = host == "github.com" || host == "www.github.com" || host.hasPrefix("github.") || host.contains("github")
                return TaskReference(raw: trimmed, id: String(n), url: token, issueRef: github ? token : nil, isGitHubLink: github)
            }
            let id = key(in: token) ?? parts.last { $0.allSatisfy(\.isASCIIDigit) } ?? parts.last.flatMap(cleanID) ?? ""
            guard !id.isEmpty else { return nil }
            return TaskReference(raw: trimmed, id: id, url: token, issueRef: nil, isGitHubLink: false)
        }
        if let m = token.wholeMatch(of: /#?(\d{1,9})/), let n = Int(m.1), n > 0 {
            return TaskReference(raw: trimmed, id: String(n), url: nil, issueRef: String(n), isGitHubLink: false)
        }
        if let m = token.wholeMatch(of: /[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(\d{1,9})/), let n = Int(m.1), n > 0 {
            return TaskReference(raw: trimmed, id: String(n), url: nil, issueRef: token, isGitHubLink: false)
        }
        if let id = key(in: token) ?? cleanID(token) {
            return TaskReference(raw: trimmed, id: id, url: nil, issueRef: nil, isGitHubLink: false)
        }
        return nil
    }

    /// Whether the engine should read this task with `gh` (`task_fetch`): a GitHub link always, a number or `owner/repo#n`
    /// when the project's tasks are GitHub issues.
    public func fetchesFromGitHub(platform: TaskPlatform) -> Bool {
        guard issueRef != nil else { return false }
        return isGitHubLink || platform == .github
    }

    /// A tracker key (`ACME-123`) in `text`.
    static func key(in text: String) -> String? {
        text.firstMatch(of: /\b([A-Z][A-Z0-9]+-\d+)\b/).map { String($0.1) }
    }

    /// The ASCII-safe part of a token (`[A-Za-z0-9._-]`, ≤ 40), nil when none is left.
    static func cleanID(_ raw: String) -> String? {
        let kept = String(raw.filter { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }.prefix(40))
            .trimmingCharacters(in: CharacterSet(charactersIn: ".-"))
        return kept.isEmpty ? nil : kept
    }
}

/// A task as the engine read it (`task_fetched`, §63), or as far as the app knows it (an MCP task: only its id and link).
public struct FetchedTask: Sendable, Equatable, Decodable {
    public var id: String
    public var number: Int?
    public var title: String
    public var body: String
    public var url: String
    public var labels: [String]

    public init(id: String, number: Int? = nil, title: String = "", body: String = "", url: String = "", labels: [String] = []) {
        self.id = id
        self.number = number
        self.title = title
        self.body = body
        self.url = url
        self.labels = labels
    }

    private enum CodingKeys: String, CodingKey { case id, number, title, body, url, labels }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let number = lenientValue(Int.self, c, .number)
        self.init(id: lenientValue(String.self, c, .id) ?? number.map(String.init) ?? "", number: number,
                  title: lenientValue(String.self, c, .title) ?? "", body: lenientValue(String.self, c, .body) ?? "",
                  url: lenientValue(String.self, c, .url) ?? "", labels: lenientValue([String].self, c, .labels) ?? [])
    }
}

/// Reply to `task_fetch` (§63).
public struct TaskFetchedReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var task: FetchedTask

    public init(id: String? = nil, task: FetchedTask) {
        self.id = id
        self.task = task
    }
}

// MARK: - The branch

/// The branch a task gets: `<prefix><id>-<slug>` — the slug from the title's ASCII words (≤ 50 characters), only the id when
/// the title has none (a Korean title) or is not known (a task Claude reads through MCP).
public enum TaskBranch {
    public static let maxSlug = 50

    public static func name(prefix: String, id: String, title: String = "", labels: [String] = []) -> String {
        let resolved = prefix.replacingOccurrences(of: "{type}", with: type(labels: labels))
        let p = TaskBranchName.cleanPrefix(resolved)
        let cleanID = TaskReference.cleanID(id) ?? "task"
        let s = slug(title, dropping: cleanID)
        return s.isEmpty ? p + cleanID : "\(p)\(cleanID)-\(s)"
    }

    /// `{type}`: `fix` for a bug, `docs`, `chore`, else `feature`.
    public static func type(labels: [String]) -> String {
        let words = labels.map { $0.lowercased() }
        if words.contains(where: { $0.contains("bug") || $0.contains("fix") || $0.contains("defect") }) { return "fix" }
        if words.contains(where: { $0.contains("doc") }) { return "docs" }
        if words.contains(where: { $0.contains("chore") || $0.contains("maintenance") }) { return "chore" }
        return "feature"
    }

    /// Lower-cased ASCII words of `title` joined by `-` (accents folded, everything else dropped), cut at a word to ≤ 50;
    /// a leading copy of the id (`ACME-123 Fix …`) is left out.
    public static func slug(_ title: String, dropping id: String = "") -> String {
        let folded = title.folding(options: [.diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
        var words = folded.split { !($0.isASCII && ($0.isLetter || $0.isNumber)) }.map(String.init)
        let idWords = id.lowercased().split { !($0.isASCII && ($0.isLetter || $0.isNumber)) }.map(String.init)
        if !idWords.isEmpty, words.starts(with: idWords) { words.removeFirst(idWords.count) }
        var out = ""
        for word in words {
            let next = out.isEmpty ? word : out + "-" + word
            if next.count > maxSlug {
                if out.isEmpty { out = String(word.prefix(maxSlug)) }
                break
            }
            out = next
        }
        return out
    }
}

// MARK: - The first prompt

/// The first message of a task's chat, from the template (Settings › Tasks): `{id} {title} {url} {body}` and `{mcp}` — the
/// line that tells Claude how to read the task. A line whose placeholders are all empty is left out; with no `{mcp}` in
/// the template the hint goes first. It is put into the composer (the terminal's prompt), never sent by itself.
public enum TaskPrompt {
    public static var defaultTemplate: String {
        String(localized: "Work on task {id}: {title}\n{url}\n\n{mcp}\n\n{body}\n\nSummarize the task first and tell me your plan before you change code.", bundle: .module)
    }

    /// How Claude gets the task: through the MCP server (Jira / Linear / other), with `gh` (a GitHub issue the app could not
    /// read), or nothing (the body is in the prompt, or there is no tracker).
    public static func hint(platform: TaskPlatform, mcpServer: String, task: FetchedTask, github: Bool) -> String {
        let server = mcpServer.trimmingCharacters(in: .whitespacesAndNewlines)
        if github {
            return task.body.isEmpty && task.title.isEmpty
                ? String(localized: "Read the issue first (gh issue view \(task.url.isEmpty ? task.id : task.url)) and summarize it.", bundle: .module)
                : ""
        }
        guard platform.readsThroughMcp else { return "" }
        guard !server.isEmpty else {
            return String(localized: "Read the task first (it is not in this message) and summarize it.", bundle: .module)
        }
        let tools = "mcp__\(toolPrefix(server))__*"
        return String(localized: "Read this task with the \(server) MCP server (its \(tools) tools) and summarize it before you start.", bundle: .module)
    }

    /// Claude Code's tool name part for a server: characters other than letters, digits, `_` and `-` become `_`.
    static func toolPrefix(_ server: String) -> String {
        String(server.map { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") ? $0 : "_" })
    }

    public static func render(template: String, task: FetchedTask, hint: String) -> String {
        let values = ["id": task.id, "title": task.title, "url": task.url, "body": task.body.trimmingCharacters(in: .whitespacesAndNewlines), "mcp": hint]
        var lines: [String] = []
        for line in template.components(separatedBy: "\n") {
            let names = values.keys.filter { line.contains("{\($0)}") }
            var out = line
            for name in names { out = out.replacingOccurrences(of: "{\(name)}", with: values[name] ?? "") }
            if !names.isEmpty {
                if names.allSatisfy({ (values[$0] ?? "").isEmpty }) { continue }
                if names.contains(where: { (values[$0] ?? "").isEmpty }) {
                    out = out.trimmingCharacters(in: .whitespaces)
                    while let last = out.last, ":—–-·".contains(last) { out = String(out.dropLast()).trimmingCharacters(in: .whitespaces) }
                }
            }
            lines.append(out)
        }
        var text = lines.joined(separator: "\n")
        while text.contains("\n\n\n") { text = text.replacingOccurrences(of: "\n\n\n", with: "\n\n") }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !hint.isEmpty, !template.contains("{mcp}") { text = hint + "\n\n" + text }
        return text
    }
}

// MARK: - The start screen

/// The three ways into a project window.
public enum StartChoice: Int, CaseIterable, Sendable {
    /// 바로 시작: straight into a new chat (the empty chat the window has, else a fresh one).
    case start = 1
    /// 업무로 시작: from a task (`TaskStartSheet`).
    case task
    /// 대화로 열기: one of the recent chats.
    case chat
}

/// What the start screen does, and when it shows.
public enum StartScreen {
    public static let recentLimit = 5

    /// When a project opened in a window: not when the user turned it off, not for a window the app opened with work of its
    /// own (a restored window, a workbench it just made), never while a turn runs or files wait for review — the window then
    /// shows its chat as before.
    public static func shouldShow(skip: Bool, suppressed: Bool, phase: GatePhase, reviewPending: Bool, composerTask: Bool) -> Bool {
        guard !skip, !suppressed, !reviewPending, !composerTask else { return false }
        return phase == .idle
    }

    /// The chats "대화로 열기" lists: newest first, at most five, ones with a turn — not archived, moved or carried on elsewhere.
    public static func recentChats(_ sessions: [SessionMeta], limit: Int = recentLimit) -> [SessionMeta] {
        Array(sessions
            .filter { !$0.archived && $0.movedTo == nil && $0.continuedIn == nil && ($0.turns > 0 || !$0.lastUserText.isEmpty) }
            .sorted { $0.updatedAt > $1.updatedAt }
            .prefix(limit))
    }

    /// 바로 시작 needs a fresh chat when the window's chat already holds a conversation.
    public static func needsNewChat(current: SessionMeta?) -> Bool {
        guard let current else { return false }
        return current.turns > 0 || !current.lastUserText.isEmpty
    }
}

/// The start screen's keyboard: 1 / 2 / 3 pick a choice, ↑ / ↓ move through the choices and then the recent chats, ↩ takes
/// the one marked, Esc is 바로 시작.
public struct StartScreenCursor: Equatable, Sendable {
    public enum Mark: Equatable, Sendable {
        case choice(StartChoice)
        /// The n-th recent chat (0-based).
        case chat(Int)
    }

    public enum Action: Equatable, Sendable {
        case start, task
        case openChat(String)
    }

    public var mark: Mark = .choice(.start)

    public init(mark: Mark = .choice(.start)) { self.mark = mark }

    /// The rows in order: the three choices (대화로 열기 only with chats), then the chats.
    private func rows(_ chats: [String]) -> [Mark] {
        let choices: [Mark] = chats.isEmpty ? [.choice(.start), .choice(.task)] : StartChoice.allCases.map { .choice($0) }
        return choices + chats.indices.map { .chat($0) }
    }

    public mutating func move(_ delta: Int, chats: [String]) {
        let all = rows(chats)
        let index = all.firstIndex(of: mark) ?? 0
        mark = all[max(0, min(all.count - 1, index + delta))]
    }

    /// 1 / 2 / 3: 바로 시작 and 업무로 시작 act at once; 3 marks the first recent chat (nothing without one).
    public mutating func press(_ number: Int, chats: [String]) -> Action? {
        switch StartChoice(rawValue: number) {
        case .start: return .start
        case .task: return .task
        case .chat:
            guard !chats.isEmpty else { return nil }
            mark = .chat(0)
            return nil
        case nil: return nil
        }
    }

    /// ↩: the marked row (대화로 열기 marks its first chat instead).
    public mutating func activate(chats: [String]) -> Action? {
        switch mark {
        case .choice(.start): return .start
        case .choice(.task): return .task
        case .choice(.chat): return press(StartChoice.chat.rawValue, chats: chats)
        case let .chat(i): return chats.indices.contains(i) ? .openChat(chats[i]) : nil
        }
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}

// MARK: - Words

/// §63 refusals of `task_fetch` in the user's words.
public enum TaskStartText {
    static func refusal(code: String, detail: String) -> String? {
        switch code {
        case "bad_task_ref": return String(localized: "Not a GitHub issue — use a number, owner/repo#123 or an issue link", bundle: .module)
        case "gh_missing": return String(localized: "GitHub CLI (gh) was not found — install it, or set its path in Settings › Advanced", bundle: .module)
        case "not_found": return String(localized: "No such issue in this repository", bundle: .module)
        case "task_fetch_failed":
            return detail.isEmpty ? String(localized: "Could not read the issue", bundle: .module)
                : String(localized: "Could not read the issue: \(detail)", bundle: .module)
        default: return nil
        }
    }

    /// Why the window's first prompt could not go into the terminal (it waits in the message box instead).
    public static var terminalPasteFailed: String {
        String(localized: "The task's first prompt could not go into the terminal — it is in the message box of a chat instead", bundle: .module)
    }
}

// MARK: - AppState

/// Where "Start from a task" starts the work.
public enum TaskStartWhere: Equatable, Sendable {
    /// A new branch from HEAD in this window (§61: uncommitted changes come along).
    case branch(String)
    /// A new workbench on this branch — its own folder and window; the prompt waits in that window.
    case workbench(String)
    /// §59: a folder tracked without git — no branch, this window.
    case here
}

extension AppState {
    /// The Tasks settings of this window's repository (else the default).
    public var taskStartSettings: TaskStartSettings {
        AppSettings.taskStartSettings(root: flowSettingsRoot, defaults: settingsDefaults)
    }

    /// The MCP servers a task can be read with: the live session's, else the ones it reported at start, by name.
    public var taskMcpServerNames: [String] {
        let names = mcp.servers.map(\.name) + (sessionInfo.capabilities?.mcpServers.map(\.name) ?? [])
        var seen = Set<String>()
        return names.filter { !$0.isEmpty && seen.insert($0).inserted }.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    /// `task_fetch {ref}`: the GitHub issue; throws the refusal in the user's words.
    public func fetchTask(ref: String) async throws -> FetchedTask {
        do {
            let reply = try await typedReply(.taskFetch(ref: ref))
            guard case let .taskFetched(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            return r.task
        } catch let error as EngineClientError {
            throw TaskStartError(message: error.userMessage)
        }
    }

    /// The start screen's chats (`StartScreen.recentChats`).
    public var startScreenChats: [SessionMeta] { StartScreen.recentChats(sessions) }

    /// 바로 시작: the window's chat when it is still empty, else a fresh one (Settings' kind).
    public func startStraight() async {
        let current = sessions.first { $0.id == currentSessionId }
        if StartScreen.needsNewChat(current: current) { await newChat() }
    }

    /// 업무로 시작 in this window: the branch (if any), a fresh chat when the current one holds a conversation, then `prompt`
    /// in its message box (the terminal's prompt in a terminal chat) — never sent. Returns why it stopped (nil: done).
    /// A workbench is the caller's (`createWorkbench` with a draft task, then its window).
    public func startTaskHere(_ place: TaskStartWhere, prompt: String) async -> String? {
        if case let .branch(name) = place {
            do {
                _ = try await typedReply(.createBranch(name: name))
                if replySink == nil { await settle() }
            } catch let error as EngineClientError {
                return error.userMessage
            } catch {
                return error.localizedDescription
            }
        }
        let current = sessions.first { $0.id == currentSessionId }
        var terminal = current?.kind == .terminal
        if StartScreen.needsNewChat(current: current) {
            guard await newChat() else { return lastError ?? String(localized: "Could not open a new chat", bundle: .module) }
            terminal = defaultChatKind == .terminal
        }
        deliverFirstPrompt(prompt, terminal: terminal)
        return nil
    }

    /// The task's first prompt where the chat takes text: a chat's message box, or a terminal chat's prompt (a bracketed
    /// paste, never Enter — retried while its Claude Code starts, up to 30 s; then the message box). `terminal` nil: the
    /// current chat's kind once the engine reports it.
    public func deliverFirstPrompt(_ text: String, terminal: Bool? = nil) {
        guard !text.isEmpty else { return }
        firstPromptTask?.cancel()
        firstPromptTask = Task { [weak self] in
            for _ in 0..<100 {
                guard let self, !Task.isCancelled else { return }
                // A draft from a new workbench can come before the snapshot that names its chat: its kind decides first.
                if terminal != nil || self.sessions.contains(where: { $0.id == self.currentSessionId }) {
                    if !(terminal ?? self.isTerminalChat) {
                        self.taskForComposer = TaskComposerText(text: text)
                        return
                    }
                    if self.isTerminalChat, self.pasteIntoTerminal(text) == nil { return }
                }
                try? await Task.sleep(for: .milliseconds(300))
            }
            guard let self, !Task.isCancelled else { return }
            self.appendLog("[warn] task-start: \(TaskStartText.terminalPasteFailed)")
            self.taskForComposer = TaskComposerText(text: text)
        }
    }
}

/// A failed task step, in the user's words.
public struct TaskStartError: Error, LocalizedError, Equatable {
    public let message: String
    public var errorDescription: String? { message }
}
