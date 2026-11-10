import Foundation
import Observation

// MARK: code-browser — docs/PROTOCOL.md §47: the user's "코드 탐색" — any file of the project opened read-only in the diff
// pane (Go to File ⌘P over `list_files`, `project_file`), and a search over the project (Find in Project ⇧⌘F,
// `project_search`) whose results open the file at their line.

/// The project file the diff pane shows, and the line to bring into view.
public struct CodeBrowserSelection: Sendable, Equatable {
    /// Repo-relative.
    public var path: String
    /// 1-based; nil = the top.
    public var line: Int?
    /// Bumped on every open, so asking for the same line again scrolls there again.
    public var tick: Int

    public init(path: String, line: Int?, tick: Int) {
        self.path = path
        self.line = line
        self.tick = tick
    }
}

/// The matches of one file, in line order.
public struct ProjectSearchGroup: Sendable, Equatable, Identifiable {
    public var path: String
    public var matches: [ProjectSearchMatch]
    public var id: String { path }

    public init(path: String, matches: [ProjectSearchMatch]) {
        self.path = path
        self.matches = matches
    }
}

public enum CodeBrowserText {
    /// Identifiers a row's "Find in Project" menu offers, at most this many.
    public static let identifierLimit = 8

    /// `path` as the repo-relative path `project_file` takes: an absolute path inside `root` (symlinks resolved on both
    /// sides, so `/tmp` and `/private/tmp` agree), or a relative one without `..`; nil for anything else.
    public static func relativePath(_ path: String, root: String) -> String? {
        var p = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if p.hasPrefix("file://"), let url = URL(string: p), url.isFileURL { p = url.path }
        guard !p.isEmpty else { return nil }
        if p.hasPrefix("/") {
            let base = URL(fileURLWithPath: root).standardizedFileURL.resolvingSymlinksInPath().path
            let full = URL(fileURLWithPath: p).standardizedFileURL.resolvingSymlinksInPath().path
            let prefix = base.hasSuffix("/") ? base : base + "/"
            guard full.hasPrefix(prefix) else { return nil }
            p = String(full.dropFirst(prefix.count))
        }
        while p.hasPrefix("./") { p.removeFirst(2) }
        let parts = p.split(separator: "/", omittingEmptySubsequences: true)
        guard !parts.isEmpty, !parts.contains(".."), !parts.contains(".") else { return nil }
        return parts.joined(separator: "/")
    }

    /// What Go to File's field holds: a file name, maybe with `:line` or `:line:column` (as a compiler prints it), or
    /// `(Name.java:42)` as a Java stack trace does.
    public static func goToFileQuery(_ raw: String) -> (name: String, line: Int?) {
        var parts = raw.trimmingCharacters(in: CharacterSet(charactersIn: " \t()")).split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        var numbers: [Int] = []
        while parts.count > 1, numbers.count < 2, let last = parts.last, let n = Int(last), n > 0 {
            numbers.insert(n, at: 0)
            parts.removeLast()
        }
        return (parts.joined(separator: ":"), numbers.first)
    }

    /// The matches grouped by file, in the order git printed them.
    public static func groups(_ matches: [ProjectSearchMatch]) -> [ProjectSearchGroup] {
        var out: [ProjectSearchGroup] = []
        var index: [String: Int] = [:]
        for m in matches {
            if let i = index[m.path] {
                out[i].matches.append(m)
            } else {
                index[m.path] = out.count
                out.append(ProjectSearchGroup(path: m.path, matches: [m]))
            }
        }
        return out
    }

    /// The words of a code line worth searching the project for: identifiers of 3+ characters, the language keywords
    /// left out, each once, in order.
    public static func identifiers(in line: String, limit: Int = identifierLimit) -> [String] {
        var out: [String] = []
        var seen = Set<String>()
        var current = ""
        func flush() {
            defer { current = "" }
            guard current.count >= 3, let first = current.unicodeScalars.first, !CharacterSet.decimalDigits.contains(first),
                  !keywords.contains(current), seen.insert(current).inserted else { return }
            out.append(current)
        }
        for ch in line {
            if ch.isLetter && ch.isASCII || ch.isNumber && ch.isASCII || ch == "_" || ch == "$" {
                current.append(ch)
            } else {
                flush()
                if out.count >= limit { return out }
            }
        }
        flush()
        return Array(out.prefix(limit))
    }

    private static let keywords: Set<String> = [
        "abstract", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue", "default", "double", "else",
        "enum", "export", "extends", "false", "final", "finally", "float", "for", "function", "if", "implements", "import", "instanceof",
        "int", "interface", "let", "long", "new", "null", "package", "private", "protected", "public", "return", "short", "static",
        "super", "switch", "synchronized", "this", "throw", "throws", "true", "try", "var", "void", "volatile", "while", "val",
        "fun", "func", "def", "self", "nil", "undefined", "async", "await", "type", "from", "struct", "override",
    ]

    /// "12 matches in 3 files", with what was left out.
    public static func summary(_ reply: ProjectSearchReply, files: Int) -> String {
        if reply.matches.isEmpty { return String(localized: "No matches", bundle: .module) }
        let base = String(localized: "\(reply.matches.count) matches in \(files) files", bundle: .module)
        if reply.timedOut { return base + " · " + String(localized: "stopped after 20 s", bundle: .module) }
        if reply.truncated { return base + " · " + String(localized: "only the first \(reply.matches.count)", bundle: .module) }
        return base
    }

    /// A refusal of `project_file` / `project_search` in the user's words.
    public static func refusal(code: String?, fallback: String) -> String {
        switch code {
        case "file_not_found": String(localized: "The file is not in the project (any more)", bundle: .module)
        case "not_a_file": String(localized: "This is not a file", bundle: .module)
        case "invalid_path": String(localized: "This path is outside the project", bundle: .module)
        case "file_unreadable": String(localized: "The file could not be read", bundle: .module)
        case "no_project": String(localized: "Open a project first", bundle: .module)
        case "unknown_command": SessionToolsSupport.updateReason
        default: fallback
        }
    }

    static func message(_ error: Error) -> String {
        let client = error as? EngineClientError
        return refusal(code: client?.refusalCode, fallback: client?.userMessage ?? error.localizedDescription)
    }
}

/// The window's code browser: the file open in the diff pane and the project search.
@MainActor
@Observable
public final class CodeBrowserStore {
    /// Recently opened files Go to File lists before anything is typed, at most this many.
    public static let recentLimit = 12

    /// The file the diff pane shows read-only; nil = the review.
    public private(set) var selection: CodeBrowserSelection?
    /// `selection`'s content once loaded (kept while a reload runs).
    public private(set) var file: ProjectFileReply?
    public private(set) var loadError: String?
    public private(set) var isLoading = false
    /// Newest first.
    public private(set) var recentPaths: [String] = []
    /// Go to File (⌘P) is shown.
    public var quickOpenShown = false
    // The project search (the sidebar's Search tab).
    public var searchQuery = ""
    public var caseSensitive = false
    public var wholeWord = false
    /// The last search's reply (for the query it names) and its matches by file.
    public private(set) var searchReply: ProjectSearchReply?
    public private(set) var searchGroups: [ProjectSearchGroup] = []
    public private(set) var isSearching = false
    public private(set) var searchError: String?
    /// `searchKey` of the latest search, running or answered (the Search tab does not run it again when shown again).
    @ObservationIgnored public private(set) var searchedKey: String?
    /// Bumped to bring the Search tab forward and focus its field (⇧⌘F, a row's "Find in Project").
    public private(set) var searchPresentTick = 0
    @ObservationIgnored private var tick = 0
    @ObservationIgnored private var loadSeq = 0
    @ObservationIgnored private var searchSeq = 0

    public init() {}

    public var isOpen: Bool { selection != nil }

    /// Shows `path` (repo-relative) at `line`; loads it unless it is the file already shown.
    func open(_ path: String, line: Int?, using request: @escaping (EngineCommand) async throws -> EngineEvent) async {
        tick += 1
        selection = CodeBrowserSelection(path: path, line: line, tick: tick)
        recentPaths.removeAll { $0 == path }
        recentPaths.insert(path, at: 0)
        if recentPaths.count > Self.recentLimit { recentPaths.removeLast(recentPaths.count - Self.recentLimit) }
        if file?.path == path, loadError == nil { return }
        file = nil
        await load(path, using: request)
    }

    /// Reads the shown file again (Claude or an editor changed it); the old lines stay until the new ones arrive.
    func reload(using request: @escaping (EngineCommand) async throws -> EngineEvent) async {
        guard let path = selection?.path else { return }
        await load(path, using: request)
    }

    private func load(_ path: String, using request: (EngineCommand) async throws -> EngineEvent) async {
        loadSeq += 1
        let seq = loadSeq
        loadError = nil
        isLoading = true
        defer { if seq == loadSeq { isLoading = false } }
        do {
            let reply = try await request(.projectFile(path: path))
            guard seq == loadSeq, selection?.path == path else { return }
            guard case let .projectFile(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            if r != file { file = r }
        } catch {
            guard seq == loadSeq, selection?.path == path else { return }
            file = nil
            loadError = CodeBrowserText.message(error)
        }
    }

    /// Back to the review: the diff pane shows the selected changed file again.
    public func close() {
        loadSeq += 1
        selection = nil
        file = nil
        loadError = nil
        isLoading = false
    }

    /// What a search is for: the query and both switches.
    public static func searchKey(query: String, caseSensitive: Bool, wholeWord: Bool) -> String {
        "\(caseSensitive ? "C" : "c")\(wholeWord ? "W" : "w")\(query)"
    }

    /// Runs `searchQuery` (an empty one clears the results); a reply to an older search is dropped.
    func search(using request: (EngineCommand) async throws -> EngineEvent) async {
        searchSeq += 1
        let seq = searchSeq
        let query = searchQuery
        let key = Self.searchKey(query: query, caseSensitive: caseSensitive, wholeWord: wholeWord)
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            searchReply = nil
            searchGroups = []
            searchError = nil
            searchedKey = nil
            isSearching = false
            return
        }
        isSearching = true
        searchedKey = key
        defer { if seq == searchSeq { isSearching = false } }
        do {
            let reply = try await request(.projectSearch(query: query, caseSensitive: caseSensitive, wholeWord: wholeWord))
            guard seq == searchSeq else { return }
            guard case let .projectSearch(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            searchReply = r
            searchGroups = CodeBrowserText.groups(r.matches)
            searchError = nil
        } catch {
            guard seq == searchSeq else { return }
            searchReply = nil
            searchGroups = []
            searchError = CodeBrowserText.message(error)
            searchedKey = nil
        }
    }

    /// A row's "Find in Project": the word as a whole, case-sensitive identifier; the Search tab comes forward.
    func prepareSearch(word: String) {
        searchQuery = word
        caseSensitive = true
        wholeWord = true
        searchPresentTick += 1
    }

    /// ⇧⌘F: the Search tab comes forward with its field focused.
    public func presentSearch() {
        searchPresentTick += 1
    }

    /// The project changed or closed.
    public func reset() {
        close()
        recentPaths = []
        quickOpenShown = false
        searchSeq += 1
        searchReply = nil
        searchGroups = []
        searchError = nil
        searchedKey = nil
        isSearching = false
    }
}

extension AppState {
    /// Opens a project file read-only in the diff pane, scrolled to `line` (1-based) — Go to File, a search result, and
    /// any link to a file (chat). `path` is repo-relative, or absolute inside the project; false when it is neither (or no
    /// project is open), nothing changes then.
    @discardableResult
    public func openProjectFile(path: String, line: Int? = nil) -> Bool {
        guard let root = projectInfo?.root, let rel = CodeBrowserText.relativePath(path, root: root) else { return false }
        Task { [weak self] in
            guard let self else { return }
            await self.codeBrowser.open(rel, line: line.map { max(1, $0) }) { [weak self] cmd in
                guard let self else { throw EngineClientError.stopped }
                return try await self.reply(cmd)
            }
        }
        return true
    }

    /// Back to the review.
    public func closeProjectFile() {
        codeBrowser.close()
    }

    /// Reads the open project file again.
    public func reloadProjectFile() async {
        await codeBrowser.reload { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }

    /// Go to File's candidates: `list_files` without the directories.
    public func quickOpenFiles(query: String) async -> [FileItem] {
        await listFiles(query: query, limit: 50).filter { !$0.isDirectory }
    }

    /// Runs the Search tab's query.
    public func searchProject() async {
        guard projectInfo != nil else { return }
        await codeBrowser.search { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }

    /// A row's "Find in Project" for `word`: the Search tab comes forward and searches it.
    public func searchProject(word: String) async {
        codeBrowser.prepareSearch(word: word)
        await searchProject()
    }
}
