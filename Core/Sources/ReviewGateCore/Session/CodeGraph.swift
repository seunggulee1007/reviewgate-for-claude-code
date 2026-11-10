import Foundation
import Observation

// MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3: the board's "코드 그래프" tab (graphify) and the user's mods.

// MARK: - Wire

/// A node of the graph with its edges (the report's "God Nodes": the most connected).
public struct CodeGraphNode: Sendable, Equatable, Decodable, Identifiable {
    public var name: String
    public var edges: Int
    public var id: String { name }

    public init(name: String, edges: Int) {
        self.name = name
        self.edges = edges
    }
}

/// An edge the report calls surprising (`from --relation--> to`), with the files as the report wrote them.
public struct CodeGraphLink: Sendable, Equatable, Decodable, Identifiable {
    public var from: String
    public var relation: String
    public var to: String
    /// `EXTRACTED` (found in the code) or `INFERRED`.
    public var confidence: String
    public var fromFile: String?
    public var toFile: String?
    public var id: String { "\(from)→\(relation)→\(to)|\(fromFile ?? "")|\(toFile ?? "")" }

    public init(from: String, relation: String, to: String, confidence: String = "", fromFile: String? = nil, toFile: String? = nil) {
        self.from = from
        self.relation = relation
        self.to = to
        self.confidence = confidence
        self.fromFile = fromFile
        self.toFile = toFile
    }

    private enum CodingKeys: String, CodingKey { case from, relation, to, confidence, fromFile, toFile }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(from: lenientValue(String.self, c, .from) ?? "", relation: lenientValue(String.self, c, .relation) ?? "",
                  to: lenientValue(String.self, c, .to) ?? "", confidence: lenientValue(String.self, c, .confidence) ?? "",
                  fromFile: lenientValue(String.self, c, .fromFile), toFile: lenientValue(String.self, c, .toFile))
    }
}

/// A community of the report, largest first.
public struct CodeGraphCommunity: Sendable, Equatable, Decodable, Identifiable {
    public var id: Int
    public var name: String
    public var nodes: Int
    public var cohesion: Double?

    public init(id: Int, name: String, nodes: Int, cohesion: Double? = nil) {
        self.id = id
        self.name = name
        self.nodes = nodes
        self.cohesion = cohesion
    }

    private enum CodingKeys: String, CodingKey { case id, name, nodes, cohesion }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(Int.self, c, .id) ?? 0, name: lenientValue(String.self, c, .name) ?? "",
                  nodes: lenientValue(Int.self, c, .nodes) ?? 0, cohesion: lenientValue(Double.self, c, .cohesion))
    }
}

/// What graphify's `GRAPH_REPORT.md` says (the engine's summary; graph.json is never read).
public struct CodeGraphReport: Sendable, Equatable, Decodable {
    public var name: String?
    public var date: String?
    public var files: Int?
    public var words: Int?
    public var nodes: Int
    public var edges: Int
    public var communities: Int
    public var extractedPct: Int?
    public var inferredPct: Int?
    public var ambiguousPct: Int?
    /// "Built from commit" (short sha); nil without git.
    public var commit: String?
    public var hubs: [String]
    public var hubCount: Int
    public var gods: [CodeGraphNode]
    public var surprises: [CodeGraphLink]
    public var bigCommunities: [CodeGraphCommunity]
    public var isolated: Int?

    public init(name: String? = nil, date: String? = nil, files: Int? = nil, words: Int? = nil, nodes: Int = 0, edges: Int = 0, communities: Int = 0,
                extractedPct: Int? = nil, inferredPct: Int? = nil, ambiguousPct: Int? = nil, commit: String? = nil, hubs: [String] = [], hubCount: Int = 0,
                gods: [CodeGraphNode] = [], surprises: [CodeGraphLink] = [], bigCommunities: [CodeGraphCommunity] = [], isolated: Int? = nil) {
        self.name = name
        self.date = date
        self.files = files
        self.words = words
        self.nodes = nodes
        self.edges = edges
        self.communities = communities
        self.extractedPct = extractedPct
        self.inferredPct = inferredPct
        self.ambiguousPct = ambiguousPct
        self.commit = commit
        self.hubs = hubs
        self.hubCount = hubCount
        self.gods = gods
        self.surprises = surprises
        self.bigCommunities = bigCommunities
        self.isolated = isolated
    }

    private enum CodingKeys: String, CodingKey {
        case name, date, files, words, nodes, edges, communities, extractedPct, inferredPct, ambiguousPct, commit, hubs, hubCount, gods, surprises, bigCommunities, isolated
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let hubs = lenientElements(String.self, c, .hubs)
        self.init(name: lenientValue(String.self, c, .name), date: lenientValue(String.self, c, .date),
                  files: lenientValue(Int.self, c, .files), words: lenientValue(Int.self, c, .words),
                  nodes: lenientValue(Int.self, c, .nodes) ?? 0, edges: lenientValue(Int.self, c, .edges) ?? 0,
                  communities: lenientValue(Int.self, c, .communities) ?? 0,
                  extractedPct: lenientValue(Int.self, c, .extractedPct), inferredPct: lenientValue(Int.self, c, .inferredPct),
                  ambiguousPct: lenientValue(Int.self, c, .ambiguousPct), commit: lenientValue(String.self, c, .commit),
                  hubs: hubs, hubCount: lenientValue(Int.self, c, .hubCount) ?? hubs.count,
                  gods: lenientElements(CodeGraphNode.self, c, .gods), surprises: lenientElements(CodeGraphLink.self, c, .surprises),
                  bigCommunities: lenientElements(CodeGraphCommunity.self, c, .bigCommunities), isolated: lenientValue(Int.self, c, .isolated))
    }
}

/// The last `graphify update .` of this project.
public struct CodeGraphBuild: Sendable, Equatable, Decodable {
    public var running: Bool
    public var startedAt: String
    public var finishedAt: String?
    public var ok: Bool?
    public var exitCode: Int?
    public var timedOut: Bool
    /// graphify's latest line while it runs, its result once it ended.
    public var line: String?

    public init(running: Bool, startedAt: String = "", finishedAt: String? = nil, ok: Bool? = nil, exitCode: Int? = nil, timedOut: Bool = false, line: String? = nil) {
        self.running = running
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.ok = ok
        self.exitCode = exitCode
        self.timedOut = timedOut
        self.line = line
    }

    private enum CodingKeys: String, CodingKey { case running, startedAt, finishedAt, ok, exitCode, timedOut, line }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(running: lenientValue(Bool.self, c, .running) ?? false, startedAt: lenientValue(String.self, c, .startedAt) ?? "",
                  finishedAt: lenientValue(String.self, c, .finishedAt), ok: lenientValue(Bool.self, c, .ok),
                  exitCode: lenientValue(Int.self, c, .exitCode), timedOut: lenientValue(Bool.self, c, .timedOut) ?? false,
                  line: lenientValue(String.self, c, .line))
    }
}

/// Reply to `code_graph` / `code_graph_build`, also emitted while a build runs and when it ends.
public struct CodeGraphReply: Sendable, Equatable, Decodable {
    public var id: String?
    /// The project root, where a build runs.
    public var root: String
    public var reportPath: String?
    /// The report is the main worktree's (this worktree has none of its own).
    public var shared: Bool
    /// ISO-8601 modification time of the report.
    public var builtAt: String?
    public var report: CodeGraphReport?
    /// `unreadable` / `too_large`.
    public var reportError: String?
    public var head: String?
    /// Commits HEAD has that the report's commit has not; nil when unknown.
    public var behind: Int?
    public var htmlPath: String?
    /// The graphify program found; nil: not installed.
    public var graphify: String?
    /// git ignores `graphify-out/` (nil: not a git repository / unknown).
    public var outIgnored: Bool?
    public var build: CodeGraphBuild?

    public init(id: String? = nil, root: String = "", reportPath: String? = nil, shared: Bool = false, builtAt: String? = nil, report: CodeGraphReport? = nil,
                reportError: String? = nil, head: String? = nil, behind: Int? = nil, htmlPath: String? = nil, graphify: String? = nil,
                outIgnored: Bool? = nil, build: CodeGraphBuild? = nil) {
        self.id = id
        self.root = root
        self.reportPath = reportPath
        self.shared = shared
        self.builtAt = builtAt
        self.report = report
        self.reportError = reportError
        self.head = head
        self.behind = behind
        self.htmlPath = htmlPath
        self.graphify = graphify
        self.outIgnored = outIgnored
        self.build = build
    }

    private enum CodingKeys: String, CodingKey { case id, root, reportPath, shared, builtAt, report, reportError, head, behind, htmlPath, graphify, outIgnored, build }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), root: lenientValue(String.self, c, .root) ?? "",
                  reportPath: lenientValue(String.self, c, .reportPath), shared: lenientValue(Bool.self, c, .shared) ?? false,
                  builtAt: lenientValue(String.self, c, .builtAt), report: lenientValue(CodeGraphReport.self, c, .report),
                  reportError: lenientValue(String.self, c, .reportError), head: lenientValue(String.self, c, .head),
                  behind: lenientValue(Int.self, c, .behind), htmlPath: lenientValue(String.self, c, .htmlPath),
                  graphify: lenientValue(String.self, c, .graphify), outIgnored: lenientValue(Bool.self, c, .outIgnored),
                  build: lenientValue(CodeGraphBuild.self, c, .build))
    }
}

/// A Claude Code mod of the user (`state.session.extensions.mods`), read only.
public struct UserMod: Sendable, Equatable, Codable, Identifiable {
    public var name: String
    public var description: String
    public var version: String?
    public var path: String
    /// `dev` (made in a Claude Code session, loaded by it only) or `plugin_dirs` (named in `CLAUDE_CODE_PLUGIN_DIRS`).
    public var source: String
    public var sessionId: String?
    public var loaded: Bool
    public var hasHooks: Bool
    public var id: String { path }

    public init(name: String, description: String = "", version: String? = nil, path: String, source: String = "dev", sessionId: String? = nil,
                loaded: Bool = false, hasHooks: Bool = false) {
        self.name = name
        self.description = description
        self.version = version
        self.path = path
        self.source = source
        self.sessionId = sessionId
        self.loaded = loaded
        self.hasHooks = hasHooks
    }

    private enum CodingKeys: String, CodingKey { case name, description, version, path, source, sessionId, loaded, hasHooks }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(name: try c.decode(String.self, forKey: .name), description: lenientValue(String.self, c, .description) ?? "",
                  version: lenientValue(String.self, c, .version), path: lenientValue(String.self, c, .path) ?? "",
                  source: lenientValue(String.self, c, .source) ?? "dev", sessionId: lenientValue(String.self, c, .sessionId),
                  loaded: lenientValue(Bool.self, c, .loaded) ?? false, hasHooks: lenientValue(Bool.self, c, .hasHooks) ?? false)
    }
}

extension SessionExtensions {
    private enum ModKeys: String, CodingKey { case mods }

    /// Called at the end of `init(from:)`.
    mutating func decodeModFields(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: ModKeys.self), c.contains(.mods) else { return }
        mods = lenientElements(UserMod.self, c, .mods).filter { !$0.name.isEmpty }
    }
}

// MARK: - Display rules (both clients: Electron `codeGraph.ts`)

public enum CodeGraphText {
    public enum Freshness: Equatable, Sendable {
        /// The report's commit is HEAD.
        case fresh
        /// HEAD is this many commits past it.
        case behind(Int)
        /// The report names a commit this repository does not have (or HEAD is unknown).
        case unknown
        /// The report has no commit (built outside git).
        case noCommit
    }

    public static func freshness(_ reply: CodeGraphReply) -> Freshness? {
        guard let report = reply.report else { return nil }
        guard report.commit != nil else { return .noCommit }
        guard let behind = reply.behind else { return .unknown }
        return behind == 0 ? .fresh : .behind(behind)
    }

    public static func freshnessLabel(_ f: Freshness) -> String {
        switch f {
        case .fresh: String(localized: "Up to date", bundle: .module)
        case let .behind(n): String(localized: "\(n) commits behind HEAD", bundle: .module)
        case .unknown: String(localized: "Its commit is not in this repository", bundle: .module)
        case .noCommit: String(localized: "Built outside git", bundle: .module)
        }
    }

    /// Why [다시 빌드] / [만들기] cannot run now; nil = it can.
    public static func buildBlockedReason(_ reply: CodeGraphReply?, unsupported: Bool) -> String? {
        if unsupported { return SessionToolsSupport.updateReason }
        guard let reply else { return String(localized: "Reading the code graph…", bundle: .module) }
        if reply.graphify == nil { return String(localized: "graphify is not installed", bundle: .module) }
        if reply.outIgnored == false {
            return String(localized: "git does not ignore graphify-out/ — add graphify-out/ to .gitignore so a build never lands in a review", bundle: .module)
        }
        if reply.build?.running == true { return String(localized: "A build is running", bundle: .module) }
        return nil
    }

    /// One line on how to install graphify (shown under the disabled button).
    public static var installHint: String {
        String(localized: "Install it in Terminal: uv tool install graphifyy (or pipx install graphifyy)", bundle: .module)
    }

    /// The empty state's note on what a build reads and costs.
    public static var buildNote: String {
        String(localized: "Only code files go in (like Java) — it uses no tokens", bundle: .module)
    }

    /// The build's line: running with its elapsed time and graphify's latest line, else how the last one ended.
    public static func buildLine(_ build: CodeGraphBuild, now: Date = Date(), language: String = ElapsedFormat.uiLanguage) -> String {
        let started = parseDate(build.startedAt)
        if build.running {
            let elapsed = started.map { ElapsedFormat.text(seconds: now.timeIntervalSince($0), language: language) } ?? ""
            let head = String(localized: "Building… \(elapsed)", bundle: .module)
            return [head, build.line].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
        }
        if build.timedOut { return String(localized: "The build ran over 10 minutes and was stopped", bundle: .module) }
        let took = started.flatMap { s in parseDate(build.finishedAt ?? "").map { ElapsedFormat.text(seconds: $0.timeIntervalSince(s), language: language) } }
        let head = build.ok == true ? String(localized: "Last build succeeded", bundle: .module) : String(localized: "Last build failed", bundle: .module)
        return [head, took, build.line].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
    }

    /// "방금" / "3분 전" / "2시간 전" / "4일 전".
    public static func ago(_ iso: String?, now: Date = Date()) -> String? {
        guard let iso, let date = parseDate(iso) else { return nil }
        let minutes = Int(max(0, now.timeIntervalSince(date)) / 60)
        if minutes < 1 { return String(localized: "just now", bundle: .module) }
        if minutes < 60 { return String(localized: "\(minutes) min ago", bundle: .module) }
        let hours = minutes / 60
        if hours < 24 { return String(localized: "\(hours) h ago", bundle: .module) }
        return String(localized: "\(hours / 24) d ago", bundle: .module)
    }

    /// A refusal of `code_graph` / `code_graph_build` in the user's words.
    public static func refusal(code: String?, fallback: String) -> String {
        switch code {
        case "graphify_missing": String(localized: "graphify is not installed", bundle: .module)
        case "graph_build_running": String(localized: "A build is running", bundle: .module)
        case "graph_out_not_ignored": String(localized: "git does not ignore graphify-out/ — add graphify-out/ to .gitignore so a build never lands in a review", bundle: .module)
        case "no_project": String(localized: "Open a project first", bundle: .module)
        case "unknown_command": SessionToolsSupport.updateReason
        default: fallback
        }
    }

    /// A bar's share of the largest value (0…1; a value never shows as nothing).
    public static func share(_ value: Int, of max: Int) -> Double {
        guard max > 0, value > 0 else { return 0 }
        return Swift.max(0.02, Swift.min(1, Double(value) / Double(max)))
    }

    /// The last path component (a surprising connection's file).
    public static func fileName(_ path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        return path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
    }

    /// graph.html is opened in the default browser only when it is that file of a graphify-out folder and exists.
    public static func canOpenHtml(_ path: String?) -> Bool {
        guard let path, path.hasPrefix("/"), !path.contains("\0") else { return false }
        let url = URL(fileURLWithPath: path)
        guard url.lastPathComponent == "graph.html", url.deletingLastPathComponent().lastPathComponent == "graphify-out" else { return false }
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue
    }

    /// The mod's state in words.
    public static func modState(_ mod: UserMod) -> String {
        if mod.loaded { return String(localized: "Loaded in this session", bundle: .module) }
        if mod.source == "dev" { return String(localized: "Loads only in the Claude Code session that made it", bundle: .module) }
        return String(localized: "Not loaded in this session", bundle: .module)
    }

    /// The note under the mods: their panels draw only in the terminal.
    public static var modsNote: String {
        String(localized: "Mod panels do not show in the app — the board has the same information", bundle: .module)
    }

    private static func parseDate(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }
}

// MARK: - The store

/// The code graph of the open project: the last reply (a request's or one the engine emitted), refreshed while its tab is shown.
@MainActor
@Observable
public final class CodeGraphStore {
    public private(set) var reply: CodeGraphReply?
    public private(set) var loading = false
    /// The last request's refusal in the user's words.
    public private(set) var errorText: String?
    /// The engine does not know `code_graph` (older engine).
    public private(set) var unsupported = false

    public init() {}

    /// Applies a `code_graph` event (a reply or one the engine emitted).
    public func apply(_ reply: CodeGraphReply) {
        self.reply = reply
        if reply.build?.running == false, errorText != nil { errorText = nil }
    }

    /// The project changed.
    public func reset() {
        reply = nil
        errorText = nil
        unsupported = false
        loading = false
    }

    func refresh(using request: (EngineCommand) async throws -> EngineEvent) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            guard case let .codeGraph(r) = try await request(.codeGraph) else { return }
            apply(r)
            errorText = nil
        } catch {
            handle(error)
        }
    }

    func build(using request: (EngineCommand) async throws -> EngineEvent) async {
        errorText = nil
        do {
            guard case let .codeGraph(r) = try await request(.codeGraphBuild) else { return }
            apply(r)
        } catch {
            handle(error)
        }
    }

    private func handle(_ error: Error) {
        let code = (error as? EngineClientError)?.refusalCode
        if code == "unknown_command" { unsupported = true }
        let fallback = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        errorText = CodeGraphText.refusal(code: code, fallback: fallback)
    }
}

extension AppState {
    /// §43.3: re-reads the code graph (the board's tab calls it every 15 s while shown).
    public func refreshCodeGraph() async {
        await codeGraph.refresh { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }

    /// §43.3: `graphify update .` in the project root (the engine refuses it without graphify, while one runs, or when git
    /// would see `graphify-out/`).
    public func buildCodeGraph() async {
        await codeGraph.build { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }
}
