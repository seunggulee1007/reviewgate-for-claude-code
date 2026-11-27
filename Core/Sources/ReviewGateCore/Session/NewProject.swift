import Foundation

// MARK: §69 start without a folder — docs/PROTOCOL.md §69: the window with no project offers New (a folder made from the
// first prompt), Start from a task (the base project picked first) and Open a folder. The name rule, the collision suffix
// and the remote match are the engine's (`project_name`, `project_create`, `project_match`); this is the Mac's side.

/// §69 reply to `project_name`: the name the rule gives, the resolved parent, the first free `<parent>/<name>[-n]`.
public struct ProjectNameReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var name: String
    public var parent: String
    public var path: String

    public init(id: String? = nil, name: String, parent: String, path: String) {
        self.id = id
        self.name = name
        self.parent = parent
        self.path = path
    }
}

/// §69 what the New sheet's name line shows: the folder `project_name` gives, or why the engine cannot say.
public enum ProjectNamePreview: Sendable, Equatable {
    case ready(ProjectNameReply)
    /// In the user's words: an engine too old for §69 (`unknown_command`), a parent setting it refuses (`bad_parent`), …
    case unavailable(String)
}

/// §69 reply to `project_create`: the folder made and opened.
public struct ProjectCreatedReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var path: String

    public init(id: String? = nil, path: String) {
        self.id = id
        self.path = path
    }
}

/// §69 reply to `project_match`: the task's `owner/repo` (nil: none named), the paths whose remote is it, the one to preselect.
public struct ProjectMatchesReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var repo: String?
    public var matches: [String]
    public var guess: String?

    public init(id: String? = nil, repo: String? = nil, matches: [String] = [], guess: String? = nil) {
        self.id = id
        self.repo = repo
        self.matches = matches
        self.guess = guess
    }

    /// The row to preselect among `candidates` (most recent first): the engine's guess, else the most recent.
    public func preselect(in candidates: [String]) -> String? {
        if let guess, candidates.contains(guess) { return guess }
        return candidates.first
    }
}

public extension AppSettings.Key {
    /// §69 (String, default empty = `~/ReviewGate`): where New makes its folders.
    static let newProjectParent = "newProjectParent"
}

public extension AppSettings {
    /// The parent folder New uses; nil: the engine's default (`~/ReviewGate`).
    static func newProjectParent(defaults: UserDefaults = .standard) -> String? {
        let p = (defaults.string(forKey: Key.newProjectParent) ?? "").trimmingCharacters(in: .whitespaces)
        return p.isEmpty ? nil : p
    }

    static func setNewProjectParent(_ path: String?, defaults: UserDefaults = .standard) {
        let p = (path ?? "").trimmingCharacters(in: .whitespaces)
        if p.isEmpty { defaults.removeObject(forKey: Key.newProjectParent) } else { defaults.set(p, forKey: Key.newProjectParent) }
    }

    /// The default shown when nothing is set (the engine resolves the same).
    static var defaultNewProjectParent: String { (NSHomeDirectory() as NSString).appendingPathComponent("ReviewGate") }

    /// The parent as the screens show it: the home folder as `~` (`~/ReviewGate` by default), as Windows shows it.
    static var newProjectParentForDisplay: String { newProjectParentForDisplay() }

    static func newProjectParentForDisplay(defaults: UserDefaults = .standard) -> String {
        ((newProjectParent(defaults: defaults) ?? defaultNewProjectParent) as NSString).abbreviatingWithTildeInPath
    }
}

/// §69 refusals in the user's words (`git_init_failed` keeps its existing wording).
public enum NewProjectText {
    static func refusal(code: String, detail: String) -> String? {
        switch code {
        case "bad_parent":
            return String(localized: "The folder for new projects must be a full path — change it in Settings › General", bundle: .module)
        case "parent_not_writable":
            return detail.isEmpty ? String(localized: "Could not make the project folder", bundle: .module)
                : String(localized: "Could not make the project folder: \(detail)", bundle: .module)
        default: return nil
        }
    }

    /// Why `project_name` gave no name: an engine before §69 says so plainly (else the sheet would wait for it forever).
    static func unavailable(_ error: Error) -> String {
        guard let error = error as? EngineClientError else { return error.localizedDescription }
        if error.refusalCode == "unknown_command" {
            return String(localized: "This engine cannot make new projects yet — update ReviewGate", bundle: .module)
        }
        return error.userMessage
    }
}

/// §69 / §74 the four choices of the window with no project: 1 New, 2 Start from a task, 3 Open a folder, 4 Clone from Git.
public enum NoProjectChoice: Int, CaseIterable, Sendable {
    case new = 1, task, open, clone

    /// ← → ↑ ↓ move the mark, stopping at either end.
    public func moved(_ delta: Int) -> NoProjectChoice {
        NoProjectChoice(rawValue: max(1, min(NoProjectChoice.allCases.count, rawValue + delta))) ?? self
    }
}

extension AppState {
    /// `project_name`: the folder New Project would make for `text`, or why there is none (the sheet shows it and Create
    /// stays off with it).
    public func newProjectName(text: String) async -> ProjectNamePreview {
        do {
            let reply = try await typedReply(.projectName(text: text, parent: AppSettings.newProjectParent(defaults: settingsDefaults)))
            guard case let .projectName(name) = reply else { return .unavailable(NewProjectText.unavailable(EngineClientError.unexpectedReply("project_name"))) }
            return .ready(name)
        } catch {
            return .unavailable(NewProjectText.unavailable(error))
        }
    }

    /// `project_create` and the open, then `prompt` where the new chat takes text — never sent (§69.4, as §63.3). `expected`:
    /// the path `project_name` previewed (the window shows it while it opens). Returns why it stopped (nil: done).
    public func createProject(name: String, expected: URL, prompt: String) async -> String? {
        var why: String?
        let command = EngineCommand.projectCreate(name: name, parent: AppSettings.newProjectParent(defaults: settingsDefaults))
        let reply: EngineEvent?
        if let replySink {
            do { reply = try await replySink(command) } catch let error as EngineClientError { return error.userMessage } catch { return error.localizedDescription }
        } else {
            reply = await open(expected, command: command) { why = $0.userMessage }
        }
        if let why { return why }
        guard case .projectCreated? = reply else { return lastError ?? String(localized: "Could not make the project folder", bundle: .module) }
        deliverFirstPrompt(prompt)
        return nil
    }

    /// `project_match`: which recent projects have the task's repository as a remote (an empty reply when the engine cannot say).
    public func matchProjects(ref: String, paths: [String]) async -> ProjectMatchesReply {
        guard case let .projectMatches(reply)? = try? await typedReply(.projectMatch(ref: ref, paths: paths)) else { return ProjectMatchesReply() }
        return reply
    }
}
