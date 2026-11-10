import Foundation

// "What changed and why": testable view logic for the review comprehension UI — risk badges and ordering of the
// changed files, the transcript folded under subagent calls, change → cause lookup and the agent activity tree
// (docs/PROTOCOL.md §12–13).

// MARK: - Risk

/// Why a changed file deserves a closer look; the order is the badge order (most serious first).
public enum FileRisk: String, CaseIterable, Sendable, Hashable {
    /// Agent config, workflows, secrets (`AppState.isSensitivePath`).
    case sensitive
    case deleted
    /// More than `FileRisk.largeThreshold` added + deleted lines.
    case large
    /// Changed only through Bash (a script / generator / formatter), not an edit tool.
    case viaBash
    case config
    case test
    // MARK: wave4b w4b-files — §40.2 (comp-12): kinds only the engine decides (`changedFiles[].risks`).
    /// The file's mode changed (made executable, 644 → 755) or a new executable file.
    case permission
    /// Database schema or migration (`*.sql`, `db/migration/**`, Flyway, Liquibase).
    case schema
    /// A MyBatis mapper (`**/mapper/**/*.xml`, `*Mapper.xml`) — the SQL the app runs.
    case sql
    /// Settings or credentials (`application*.yml` / `.properties`, any `*.properties`).
    case settings
    /// A build pipeline (Jenkinsfile, `.github/workflows`, GitLab CI, …).
    case ci

    /// Added + deleted lines above which a file counts as large.
    public static let largeThreshold = 300

    /// Weight for ordering; tests and config count less than a deletion or a secret.
    var weight: Int {
        switch self {
        case .sensitive: 100
        case .deleted: 40
        case .large: 30
        case .viaBash: 20
        case .config: 15
        // wave4b w4b-files (comp-12): below an ordinary edit, so a test never sorts above the code it tests (the engine's -1).
        case .test: -1
        // MARK: wave4b w4b-files — the engine's weights (`FILE_RISK_WEIGHT`)
        case .permission: 40
        case .schema: 35
        case .sql: 25
        case .settings: 20
        case .ci: 20
        }
    }

    // MARK: wave4b w4b-files — §40.2: the engine's kinds ("bash" is `.viaBash`; "external" has its own chip, `ExternalChip`).
    static func fromEngine(_ kind: String) -> FileRisk? {
        switch kind {
        case "bash": .viaBash
        case "external": nil
        default: FileRisk(rawValue: kind)
        }
    }

    /// Classifies one changed file.
    public static func risks(for file: ChangedFile) -> [FileRisk] {
        // MARK: wave4b w4b-files — §40.2: the engine decided (unknown kinds of a newer engine dropped); else the rules below.
        if let engine = file.engineRisks { return engine.compactMap(fromEngine) }
        var out: [FileRisk] = []
        if AppState.isSensitivePath(file.path) || file.oldPath.map(AppState.isSensitivePath) == true { out.append(.sensitive) }
        if file.status == .deleted { out.append(.deleted) }
        if file.added + file.deleted > largeThreshold { out.append(.large) }
        if isViaBash(file) { out.append(.viaBash) }
        if isConfigPath(file.path) { out.append(.config) }
        if isTestPath(file.path) { out.append(.test) }
        return out
    }

    /// Sum of the weights; 0 for an ordinary edit.
    public static func score(_ file: ChangedFile) -> Int {
        if let engine = file.riskScore { return engine }   // MARK: wave4b w4b-files — §40.2
        return risks(for: file).reduce(0) { $0 + $1.weight }
    }

    /// Riskiest first, git order among equals (stable).
    public static func ordered(_ files: [ChangedFile]) -> [ChangedFile] {
        files.enumerated()
            .map { (offset: $0.offset, file: $0.element, score: score($0.element)) }
            .sorted { $0.score != $1.score ? $0.score > $1.score : $0.offset < $1.offset }
            .map(\.file)
    }

    /// §31 (M2): a Bash call changed it. An empty `tools` never means Bash: a file nothing of Claude's explains is
    /// `external` (an IDE save, another session, `git pull`) and gets its own badge, or reads "원인 기록 없음".
    /// wave2 mac-diff (comp-05): Bash must be the only cause in `tools` (no edit / MCP tool), whatever the origin says, and
    /// an origin other than `.bash` wins over the tools; an older engine without origin is judged by the tools alone.
    public static func isViaBash(_ file: ChangedFile) -> Bool {
        guard file.origin == nil || file.origin == .bash else { return false }
        return file.tools.contains("Bash") && !file.tools.contains { ToolCallRecord.editTools.contains($0) || $0.hasPrefix("mcp__") }
    }

    public static func isTestPath(_ path: String) -> Bool {
        let lower = path.lowercased()
        let name = (lower as NSString).lastPathComponent
        let parts = lower.split(separator: "/").dropLast()
        if parts.contains(where: { ["test", "tests", "__tests__", "spec", "specs", "__mocks__"].contains($0) || $0.hasSuffix("tests") }) {
            return true
        }
        let stem = (name as NSString).deletingPathExtension
        if stem.hasSuffix(".test") || stem.hasSuffix(".spec") || stem.hasSuffix("_test") || stem.hasSuffix("_spec") { return true }
        if stem.hasPrefix("test_") { return true }
        // Swift / Kotlin / Java style: FooTests.swift, FooTest.kt
        let original = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        return original.hasSuffix("Tests") || original.hasSuffix("Test")
    }

    private static let lockfiles: Set<String> = [
        "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "cargo.lock", "gemfile.lock", "poetry.lock",
        "pipfile.lock", "composer.lock", "go.sum", "package.resolved", "podfile.lock", "uv.lock",
    ]
    private static let manifests: Set<String> = [
        "package.json", "tsconfig.json", "cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "gemfile", "podfile",
        "package.swift", "project.yml", "makefile", "dockerfile", "docker-compose.yml", "docker-compose.yaml", "pom.xml",
        "build.gradle", "build.gradle.kts", "settings.gradle", "setup.py", "setup.cfg", ".gitignore", ".gitattributes",
        ".npmrc", ".nvmrc", ".editorconfig",
    ]
    private static let configExtensions: Set<String> = ["yml", "yaml", "toml", "ini", "cfg", "conf", "plist", "xcconfig", "entitlements", "pbxproj"]

    /// Build / dependency / tool configuration, lockfiles included.
    public static func isConfigPath(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent.lowercased()
        if lockfiles.contains(name) || manifests.contains(name) { return true }
        if name.hasSuffix(".lock") { return true }
        if name.contains(".config.") || name.hasSuffix("rc") && name.hasPrefix(".") || name.hasSuffix("rc.json") || name.hasSuffix("rc.js") {
            return true
        }
        return configExtensions.contains((name as NSString).pathExtension)
    }
}

// MARK: - Paths

public enum RepoPath {
    /// `path` relative to `root` when it lies inside it; unchanged otherwise (already relative, or outside).
    public static func relative(_ path: String, root: String?) -> String {
        guard let root, path.hasPrefix("/") else { return path }
        let prefix = root.hasSuffix("/") ? root : root + "/"
        return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path
    }
}

// MARK: - Transcript index

/// One tool call as the transcript recorded it.
public struct ToolCallRecord: Sendable, Equatable {
    public var rowID: UUID
    public var toolUseId: String
    public var name: String
    public var file: String?
    public var input: JSONValue
    public var info: ToolUseInfo
    public var resultRowID: UUID?
    public var isError: Bool?
    public var preview: String?
    public var resultInfo: ToolResultInfo?

    /// `Agent` / `Task`: the call spawns a subagent whose own calls carry it as `parentToolUseId`.
    public var spawnsAgent: Bool { ToolCallRecord.isAgentTool(name) }
    public var isEdit: Bool { ToolCallRecord.editTools.contains(name) }

    public static let editTools: Set<String> = ["Edit", "Write", "MultiEdit", "NotebookEdit"]
    public static func isAgentTool(_ name: String) -> Bool { name == "Agent" || name == "Task" }

    /// One line for the call: the Bash command, the agent description, the pattern, or the file.
    public func shortInput(root: String?) -> String {
        if let cmd = input["command"]?.stringValue { return cmd.split(separator: "\n").first.map(String.init) ?? cmd }
        if spawnsAgent, let desc = input["description"]?.stringValue { return desc }
        if let file { return RepoPath.relative(file, root: root) }
        if let path = input["file_path"]?.stringValue ?? input["notebook_path"]?.stringValue { return RepoPath.relative(path, root: root) }
        if let pattern = input["pattern"]?.stringValue { return pattern }
        return ""
    }
}

/// Lookup tables over the transcript, keyed by tool_use id.
public struct TranscriptIndex: Sendable, Equatable {
    public private(set) var calls: [String: ToolCallRecord] = [:]
    /// Row id → the tool_use id it belongs to (tool_use and tool_result rows).
    public private(set) var toolUseIdByRow: [UUID: String] = [:]

    public init(_ items: [ChatItem]) {
        for item in items { append(item) }
    }

    /// MARK: wave7 w7-chat — §45.1: one more row (`TranscriptModel` keeps the index up to date row by row).
    public mutating func append(_ item: ChatItem) {
        switch item {
        case let .toolUse(rowID, toolUseId, name, file, input, info):
            calls[toolUseId] = ToolCallRecord(rowID: rowID, toolUseId: toolUseId, name: name, file: file, input: input, info: info)
            toolUseIdByRow[rowID] = toolUseId
        case let .toolResult(rowID, toolUseId, isError, preview, info):
            calls[toolUseId]?.resultRowID = rowID
            calls[toolUseId]?.isError = isError
            calls[toolUseId]?.preview = preview
            calls[toolUseId]?.resultInfo = info
            toolUseIdByRow[rowID] = toolUseId
        default:
            break
        }
    }

    /// The subagent's parent call chain of `toolUseId`, innermost first (the Agent/Task calls it runs under).
    public func ancestors(of toolUseId: String) -> [ToolCallRecord] {
        var out: [ToolCallRecord] = []
        var seen: Set<String> = [toolUseId]
        var next = calls[toolUseId]?.info.parentToolUseId
        while let id = next, !seen.contains(id) {
            seen.insert(id)
            guard let parent = calls[id] else { break }
            out.append(parent)
            next = parent.info.parentToolUseId
        }
        return out
    }
}

// MARK: - Change → cause

/// One tool call that touched a changed file, resolved against the transcript for the "why did this change" list.
public struct ChangeCause: Sendable, Equatable, Identifiable {
    public var id: String { toolUseId }
    public var toolUseId: String
    /// nil when the call is not in the transcript (cleared chat, older session).
    public var call: ToolCallRecord?
    /// The call's own rationale (a subagent's call: the subagent's text, §34.8). wave2 mac-diff (agents-03): no longer the
    /// enclosing Agent call's sentence — that is `delegation`, shown apart as "위임 이유".
    public var rationale: String?
    /// The innermost subagent the call ran in (its Agent/Task call), nil at top level.
    public var agent: ToolCallRecord?
    // MARK: wave2 mac-diff
    /// The call ran in a subagent: the nearest enclosing Agent call's rationale (why the main agent delegated).
    public var delegation: String?
    /// §34.8: `rationale` is the call's own message (`.sameMessage`) or the same agent's earlier text (`.earlier`).
    public var rationaleSource: RationaleSource?
    /// `.earlier`: the agent's calls between that text and this one.
    public var rationaleAge: Int?

    /// MARK: r2-skills-side — §31.1 (M35): the slash command whose !`command` lines made the change (cause id
    /// `skill:<name>`: no tool call, no transcript row), else nil.
    public var command: String? { call == nil ? SkillCause.command(of: toolUseId) : nil }
    public var toolName: String { call?.name ?? (command != nil ? "Skill" : "?") }
    public var agentLabel: String? {
        guard let agent else { return nil }
        return agent.input["subagent_type"]?.stringValue ?? agent.input["description"]?.stringValue ?? agent.name
    }

    /// Every touching call, in the engine's order (the turn's chronological order).
    public static func causes(for file: ChangedFile, in index: TranscriptIndex) -> [ChangeCause] {
        var seen: Set<String> = []
        return file.toolUseIds.compactMap { id in
            guard seen.insert(id).inserted else { return nil }
            let call = index.calls[id]
            let chain = index.ancestors(of: id)
            let rationale = call?.info.rationale.flatMap(nonEmpty)
            var cause = ChangeCause(toolUseId: id, call: call, rationale: rationale, agent: chain.first)
            cause.delegation = chain.lazy.compactMap { $0.info.rationale.flatMap(nonEmpty) }.first
            if rationale != nil {
                cause.rationaleSource = call?.info.rationaleSource
                cause.rationaleAge = call?.info.rationaleAge
            }
            return cause
        }
    }

    /// The call's reason is an earlier sentence of the agent, not its own message ("앞선 설명", dimmed).
    public var isEarlierRationale: Bool { rationaleSource == .earlier }

    private static func nonEmpty(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}

public enum ChangeLinks {
    /// tool_use id → the changed files it touched (the inverse of `ChangedFile.toolUseIds`), in list order.
    public static func filesByToolUse(_ files: [ChangedFile]) -> [String: [ChangedFile]] {
        var map: [String: [ChangedFile]] = [:]
        for file in files {
            for id in Set(file.toolUseIds) { map[id, default: []].append(file) }
        }
        return map
    }

    /// The changed file a tool row points at: one the call touched per `toolUseIds`, else the file its input names.
    public static func targetFile(toolUseId: String, file: String?, files: [ChangedFile], root: String?,
                                  byToolUse: [String: [ChangedFile]]) -> ChangedFile? {
        if let linked = byToolUse[toolUseId]?.first { return linked }
        guard let file else { return nil }
        let rel = RepoPath.relative(file, root: root)
        return files.first { $0.path == rel }
    }
}

// MARK: - Transcript nesting

/// The transcript with each subagent's calls folded under the Agent/Task row that spawned it (recursively).
public indirect enum TranscriptNode: Identifiable, Sendable, Equatable {
    /// An ordinary row (text, a top-level or nested tool call / result, …).
    case row(ChatItem)
    /// An Agent/Task call: its row, the rows of its subagent (nested groups included) and its own result.
    case agentGroup(call: ChatItem, toolUseId: String, children: [TranscriptNode], result: ChatItem?)

    public var id: UUID {
        switch self {
        case let .row(item): item.id
        case let .agentGroup(call, _, _, _): call.id
        }
    }

    /// Tool calls in the subtree (results excluded), nested groups included.
    public var callCount: Int {
        switch self {
        case let .row(item):
            if case .toolUse = item { return 1 }
            return 0
        case let .agentGroup(_, _, children, _):
            return children.reduce(0) { $0 + $1.callCount + ($1.isGroup ? 1 : 0) }
        }
    }

    public var isGroup: Bool {
        if case .agentGroup = self { return true }
        return false
    }

    /// Builds the tree. Rows whose parent call is not in the transcript stay at the top level.
    public static func build(_ items: [ChatItem]) -> [TranscriptNode] {
        var parentOf: [String: String] = [:]          // tool_use id → parent tool_use id
        var agentCalls: Set<String> = []
        for item in items {
            if case let .toolUse(_, id, name, _, _, info) = item {
                if let parent = info.parentToolUseId { parentOf[id] = parent }
                if ToolCallRecord.isAgentTool(name) { agentCalls.insert(id) }
            }
        }
        // Each row's owner: the agent call it belongs under (nil = top level).
        func owner(_ item: ChatItem) -> String? {
            let parent: String?
            switch item {
            case let .toolUse(_, id, _, _, _, info): parent = info.parentToolUseId ?? parentOf[id]
            case let .toolResult(_, toolUseId, _, _, info): parent = info.parentToolUseId ?? parentOf[toolUseId]
            default: return nil
            }
            guard let parent, agentCalls.contains(parent) else { return nil }
            return parent
        }
        var childrenOf: [String: [ChatItem]] = [:]
        var resultOf: [String: ChatItem] = [:]
        var roots: [ChatItem] = []
        for item in items {
            if case let .toolResult(_, toolUseId, _, _, _) = item, agentCalls.contains(toolUseId) {
                resultOf[toolUseId] = item
                continue
            }
            if let o = owner(item) { childrenOf[o, default: []].append(item) } else { roots.append(item) }
        }
        var visiting: Set<String> = []
        func node(_ item: ChatItem) -> TranscriptNode {
            guard case let .toolUse(_, id, _, _, _, _) = item, agentCalls.contains(id), !visiting.contains(id) else { return .row(item) }
            visiting.insert(id)
            defer { visiting.remove(id) }
            return .agentGroup(call: item, toolUseId: id, children: (childrenOf[id] ?? []).map(node), result: resultOf[id])
        }
        return roots.map(node)
    }

    /// The agent groups enclosing the row of `toolUseId`, outermost first (to expand them before scrolling).
    public static func enclosingGroups(of toolUseId: String, in nodes: [TranscriptNode]) -> [String]? {
        for n in nodes {
            switch n {
            case let .row(item):
                switch item {
                case let .toolUse(_, id, _, _, _, _) where id == toolUseId: return []
                default: continue
                }
            case let .agentGroup(_, id, children, _):
                if id == toolUseId { return [] }
                if let inner = enclosingGroups(of: toolUseId, in: children) { return [id] + inner }
            }
        }
        return nil
    }
}

// MARK: - Agent tree

public extension AgentStatus {
    /// Still doing (or able to resume) work.
    var isLive: Bool { self == .pending || self == .running || self == .paused }
}

/// `state.hud.agents` as a tree (by `parentToolUseId`), siblings in start order.
public struct AgentTreeNode: Identifiable, Sendable, Equatable {
    public var id: String { agent.toolUseId }
    public var agent: AgentNode
    public var children: [AgentTreeNode]

    public init(agent: AgentNode, children: [AgentTreeNode] = []) {
        self.agent = agent
        self.children = children
    }

    /// Roots are agents without a parent or whose parent is not listed (dropped / never reported).
    public static func build(_ agents: [AgentNode]) -> [AgentTreeNode] {
        let ids = Set(agents.map(\.toolUseId))
        var byParent: [String: [AgentNode]] = [:]
        var roots: [AgentNode] = []
        for a in agents {
            if let p = a.parentToolUseId, ids.contains(p), p != a.toolUseId { byParent[p, default: []].append(a) } else { roots.append(a) }
        }
        var visiting: Set<String> = []
        func make(_ a: AgentNode) -> AgentTreeNode {
            visiting.insert(a.toolUseId)
            defer { visiting.remove(a.toolUseId) }
            let kids = (byParent[a.toolUseId] ?? []).filter { !visiting.contains($0.toolUseId) }
            return AgentTreeNode(agent: a, children: sortByStart(kids).map(make))
        }
        return sortByStart(roots).map(make)
    }

    private static func sortByStart(_ list: [AgentNode]) -> [AgentNode] {
        list.enumerated().sorted { $0.element.startedAt != $1.element.startedAt ? $0.element.startedAt < $1.element.startedAt : $0.offset < $1.offset }
            .map(\.element)
    }

    /// Siblings grouped into batches that ran at the same time (overlapping start…end): a batch of more than one is
    /// rendered side by side. `now` (epoch ms) closes live agents.
    public static func parallelBatches(_ siblings: [AgentTreeNode], now: Double) -> [[AgentTreeNode]] {
        var batches: [[AgentTreeNode]] = []
        var batchEnd = -Double.infinity
        for node in siblings {
            let start = node.agent.startedAt
            let end = node.agent.endedAt ?? (node.agent.status.isLive ? now : start + Double(node.agent.durationMs ?? 0))
            if !batches.isEmpty, start < batchEnd {
                batches[batches.count - 1].append(node)
                batchEnd = max(batchEnd, end)
            } else {
                batches.append([node])
                batchEnd = end
            }
        }
        return batches
    }

    /// Depth-first order with each node's tree depth (0 for roots) — the gantt rows.
    public static func flatten(_ roots: [AgentTreeNode]) -> [(agent: AgentNode, level: Int)] {
        var out: [(AgentNode, Int)] = []
        func walk(_ n: AgentTreeNode, _ level: Int) {
            out.append((n.agent, level))
            n.children.forEach { walk($0, level + 1) }
        }
        roots.forEach { walk($0, 0) }
        return out
    }
}

public extension AgentNode {
    /// Milliseconds the agent has run (live agents up to `now`, epoch ms).
    func elapsedMs(now: Double) -> Double {
        if let endedAt { return max(0, endedAt - startedAt) }
        if status.isLive { return max(0, now - startedAt) }
        return Double(durationMs ?? 0)
    }
}
