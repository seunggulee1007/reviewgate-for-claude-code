import Foundation

// MARK: §74 clone from git — docs/PROTOCOL.md §74: the window with no project's fourth card. The link rule, the folder, the
// "already cloned" match, the clone with its progress and its reasons are the engine's (`project_clone_preview`,
// `project_clone`, `project_clone_cancel`); this is the Mac's side: the wire, the words and the store's actions.

/// §74 reply to `project_clone_preview`: the URL as git gets it, the repository, the folder, the recent projects that have it.
public struct ProjectClonePreviewReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var url: String
    public var repo: String
    public var host: String?
    public var branch: String?
    public var name: String
    public var parent: String
    public var path: String
    public var matches: [String]

    public init(id: String? = nil, url: String, repo: String, host: String? = nil, branch: String? = nil, name: String, parent: String, path: String, matches: [String] = []) {
        self.id = id
        self.url = url
        self.repo = repo
        self.host = host
        self.branch = branch
        self.name = name
        self.parent = parent
        self.path = path
        self.matches = matches
    }

    private enum CodingKeys: String, CodingKey { case id, url, repo, host, branch, name, parent, path, matches }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = lenientValue(String.self, c, .id)
        url = try c.decode(String.self, forKey: .url)
        name = try c.decode(String.self, forKey: .name)
        parent = try c.decode(String.self, forKey: .parent)
        path = try c.decode(String.self, forKey: .path)
        repo = lenientValue(String.self, c, .repo) ?? name
        host = lenientValue(String.self, c, .host)
        branch = lenientValue(String.self, c, .branch)
        matches = lenientValue([String].self, c, .matches) ?? []
    }
}

/// §74 the steps git reports, in order.
public enum ClonePhase: String, Sendable, Equatable, CaseIterable {
    case connecting, counting, compressing, receiving, resolving, checkout
}

/// §74 `project_clone_progress`: a step of the running clone (never a reply).
public struct ProjectCloneProgress: Sendable, Equatable, Decodable {
    public var path: String
    public var phase: ClonePhase
    /// The whole clone, 0–100.
    public var percent: Int
    public var phasePercent: Int?
    /// The size and speed while receiving (`1.20 MiB | 512.00 KiB/s`).
    public var detail: String?

    public init(path: String, phase: ClonePhase, percent: Int, phasePercent: Int? = nil, detail: String? = nil) {
        self.path = path
        self.phase = phase
        self.percent = percent
        self.phasePercent = phasePercent
        self.detail = detail
    }

    private enum CodingKeys: String, CodingKey { case path, phase, percent, phasePercent, detail }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = lenientValue(String.self, c, .path) ?? ""
        phase = ClonePhase(rawValue: lenientValue(String.self, c, .phase) ?? "") ?? .connecting
        percent = max(0, min(100, lenientValue(Int.self, c, .percent) ?? 0))
        phasePercent = lenientValue(Int.self, c, .phasePercent)
        detail = lenientValue(String.self, c, .detail)
    }
}

/// §74 reply to `project_clone`: the folder cloned and opened.
public struct ProjectClonedReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var path: String

    public init(id: String? = nil, path: String) {
        self.id = id
        self.path = path
    }
}

/// §74 what the clone sheet's status line shows: the preview, or why there is none.
public enum ClonePreviewOutcome: Sendable, Equatable {
    case ready(ProjectClonePreviewReply)
    case unavailable(String)
}

/// §74 how a clone ended.
public enum CloneOutcome: Sendable, Equatable {
    case opened
    /// The user's Cancel (nothing to show: the sheet goes back to the form).
    case cancelled
    case failed(String)
}

extension EngineCommand {
    private enum CloneKeys: String, CodingKey { case url, name, parent, paths, branch }

    /// `project_clone_preview {url, name?, parent?, paths}`, `project_clone {url, name?, parent?, branch?}`, `project_clone_cancel`.
    func encodeCloneFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CloneKeys.self)
        switch self {
        case let .projectClonePreview(url, name, parent, paths):
            try c.encode(url, forKey: .url)
            try c.encodeIfPresent(name, forKey: .name)
            try c.encodeIfPresent(parent, forKey: .parent)
            try c.encode(paths, forKey: .paths)
        case let .projectClone(url, name, parent, branch):
            try c.encode(url, forKey: .url)
            try c.encodeIfPresent(name, forKey: .name)
            try c.encodeIfPresent(parent, forKey: .parent)
            try c.encodeIfPresent(branch, forKey: .branch)
        default: break
        }
    }
}

/// §74 the clone's words: its refusals in the user's words and the steps of its progress.
public enum CloneProjectText {
    static func refusal(code: String, detail: String) -> String? {
        switch code {
        case "clone_auth_failed":
            return String(localized: "git could not sign in to this repository. For GitHub, run gh auth login in a terminal (it sets up git's sign-in too), or set up an SSH key.", bundle: .module)
        case "clone_not_found":
            return String(localized: "Repository not found — check the link, and that your account can see it", bundle: .module)
        case "clone_branch_not_found":
            return String(localized: "That branch is not in the repository — leave Branch empty for its default branch", bundle: .module)
        case "clone_network":
            return String(localized: "Could not reach the server — check the network or VPN, then try again", bundle: .module)
        case "clone_timeout":
            return String(localized: "git stopped answering for 2 minutes — check the network, then try again", bundle: .module)
        case "clone_folder_exists":
            return String(localized: "That folder already exists — choose another folder name", bundle: .module)
        case "git_missing":
            return String(localized: "git was not found — install it (xcode-select --install in Terminal), then try again", bundle: .module)
        case "clone_failed":
            return detail.isEmpty ? String(localized: "git clone failed", bundle: .module) : String(localized: "git clone failed: \(detail)", bundle: .module)
        case "bad_url":
            return String(localized: "This is not a repository link — paste an https or SSH URL, or owner/repo", bundle: .module)
        case "url_has_credentials":
            return String(localized: "Take the password or token out of the link — git signs in with your saved sign-in", bundle: .module)
        case "bad_branch":
            return String(localized: "That is not a branch name", bundle: .module)
        case "clone_busy":
            return String(localized: "Another clone is running — wait for it or cancel it", bundle: .module)
        case "clone_cancelled":
            return String(localized: "Clone cancelled", bundle: .module)
        default: return nil
        }
    }

    /// The step under the progress bar.
    public static func phase(_ phase: ClonePhase) -> String {
        switch phase {
        case .connecting: String(localized: "Connecting…", bundle: .module)
        case .counting: String(localized: "Counting objects…", bundle: .module)
        case .compressing: String(localized: "Compressing objects…", bundle: .module)
        case .receiving: String(localized: "Receiving objects…", bundle: .module)
        case .resolving: String(localized: "Resolving deltas…", bundle: .module)
        case .checkout: String(localized: "Checking out files…", bundle: .module)
        }
    }

    /// Why `project_clone_preview` gave nothing: an engine before §74 says so plainly.
    static func unavailable(_ error: Error) -> String {
        guard let error = error as? EngineClientError else { return error.localizedDescription }
        if error.refusalCode == "unknown_command" {
            return String(localized: "This engine cannot clone yet — update ReviewGate", bundle: .module)
        }
        return error.userMessage
    }

    /// §74.4 "Start from a task": the link to clone for a task whose repository (`owner/repo`) no recent project has — on the
    /// link's host when the task is a link, else GitHub's shorthand.
    public static func cloneURL(forTask ref: String, repo: String) -> String {
        let token = ref.split(whereSeparator: \.isWhitespace).map(String.init).first { $0.hasPrefix("https://") || $0.hasPrefix("http://") }
        if let token, let url = URL(string: token), let host = url.host, !host.isEmpty {
            return "https://\(host)/\(repo).git"
        }
        return repo
    }
}

extension AppState {
    /// `project_clone_preview`: what `url` clones and where, the recent projects that already have it (`paths`).
    public func clonePreview(url: String, name: String?, paths: [String]) async -> ClonePreviewOutcome {
        do {
            let command = EngineCommand.projectClonePreview(url: url, name: name, parent: AppSettings.newProjectParent(defaults: settingsDefaults), paths: paths)
            guard case let .projectClonePreview(reply) = try await typedReply(command) else {
                return .unavailable(CloneProjectText.unavailable(EngineClientError.unexpectedReply("project_clone_preview")))
            }
            return .ready(reply)
        } catch {
            return .unavailable(CloneProjectText.unavailable(error))
        }
    }

    /// `project_clone` and the open (through the same path as Open Project; a refusal goes back to the sheet). `expected`: the
    /// path the preview named (the window shows it while it opens). The project's start screen shows as after any open.
    public func cloneProject(url: String, name: String?, branch: String?, expected: URL) async -> CloneOutcome {
        cloneProgress = nil
        defer { cloneProgress = nil }
        var refusal: EngineClientError?
        let command = EngineCommand.projectClone(url: url, name: name, parent: AppSettings.newProjectParent(defaults: settingsDefaults), branch: branch)
        let reply: EngineEvent?
        if let replySink {
            do { reply = try await replySink(command) } catch let error as EngineClientError { refusal = error; reply = nil } catch { return .failed(error.localizedDescription) }
        } else {
            reply = await open(expected, command: command) { refusal = $0 }
        }
        if let refusal {
            return refusal.refusalCode == "clone_cancelled" ? .cancelled : .failed(refusal.userMessage)
        }
        guard case .projectCloned? = reply else { return .failed(lastError ?? String(localized: "git clone failed", bundle: .module)) }
        return .opened
    }

    /// `project_clone_cancel`: git is stopped and its folder removed; the running `cloneProject` ends `.cancelled`.
    public func cancelClone() async {
        _ = try? await typedReply(.projectCloneCancel)
    }

    /// A step of the running clone (`project_clone_progress`).
    func applyCloneProgress(_ progress: ProjectCloneProgress) {
        cloneProgress = progress
    }
}
