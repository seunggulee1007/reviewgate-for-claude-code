import Foundation

// MARK: wave4b w4b-tabs — docs/PROTOCOL.md §39.2 (market-12): consecutive exploration calls (the engine marks a call
// that only reads or searches `explore: true` — Read, Glob, Grep, LS, read-only Bash, an MCP lookup) fold into one
// "탐색: 파일 12개 읽음 · 검색 5회" row that opens to the list. Edits, other Bash, permission cards, agent groups, error rows
// and an exploration call that failed are never folded; Claude's text ends a run. Electron: renderer/exploreFold.ts.

/// A run of exploration rows shown as one line.
public struct ExploreRun: Identifiable, Sendable, Equatable {
    /// The first row's id (stable while the run grows).
    public let id: UUID
    /// The folded nodes in order (calls and their results).
    public let nodes: [TranscriptNode]
    public let counts: ExploreCounts

    /// The run holds this row (a find match or a revealed call opens it).
    public func contains(row: UUID?) -> Bool {
        guard let row else { return false }
        return nodes.contains { $0.id == row }
    }

    /// The run holds the call `toolUseId`.
    public func contains(toolUseId: String?) -> Bool {
        guard let toolUseId else { return false }
        return nodes.contains {
            if case let .row(.toolUse(_, id, _, _, _, _)) = $0 { return id == toolUseId }
            return false
        }
    }
}

/// What a run did: files read (distinct paths), searches (Grep, Glob, LS), read-only commands and other lookups.
public struct ExploreCounts: Sendable, Equatable {
    public var files = 0
    public var searches = 0
    public var commands = 0
    public var lookups = 0
    /// Calls without a result yet.
    public var open = 0

    public init(files: Int = 0, searches: Int = 0, commands: Int = 0, lookups: Int = 0, open: Int = 0) {
        self.files = files
        self.searches = searches
        self.commands = commands
        self.lookups = lookups
        self.open = open
    }

    /// "파일 12개 읽음 · 검색 5회 · 명령 2개" — the parts that are not zero.
    public var summary: String {
        var parts: [String] = []
        if files > 0 { parts.append(String(localized: "\(files) files read", bundle: .module)) }
        if searches > 0 { parts.append(String(localized: "\(searches) searches", bundle: .module)) }
        if commands > 0 { parts.append(String(localized: "\(commands) commands", bundle: .module)) }
        if lookups > 0 { parts.append(String(localized: "\(lookups) lookups", bundle: .module)) }
        return parts.joined(separator: " · ")
    }
}

public enum ExploreFold {
    /// One entry of the folded transcript: a node as before, or a folded run.
    public enum Entry: Identifiable, Sendable, Equatable {
        case node(TranscriptNode)
        case run(ExploreRun)

        public var id: UUID {
            switch self {
            case let .node(node): node.id
            case let .run(run): run.id
            }
        }
    }

    /// Fewer calls than this stay as they are.
    public static let minCalls = 2
    /// UserDefaults: Settings › General "탐색 행 자세히 보기" — every row as before, nothing folded (absent = off).
    public static let detailDefaultsKey = "showExploreDetail"

    private enum Keys: String, CodingKey { case explore }

    /// `tool_use.explore` (event and row); anything but `true` reads as false.
    static func flag(from decoder: Decoder) -> Bool {
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return false }
        return (try? c.decodeIfPresent(Bool.self, forKey: .explore)) == true
    }

    /// The top-level nodes with every run of at least `minCalls` exploration calls folded. A call is part of a run while
    /// the engine marked it, it runs at the top level and its result is not an error; its result row goes with it.
    public static func fold(_ nodes: [TranscriptNode]) -> [Entry] {
        var failed: Set<String> = []
        for node in nodes {
            if case let .row(.toolResult(_, toolUseId, true, _, _)) = node { failed.insert(toolUseId) }
        }
        var entries: [Entry] = []
        var run: [TranscriptNode] = []
        var runCalls: Set<String> = []
        func flush() {
            if runCalls.count >= minCalls, let first = run.first {
                entries.append(.run(ExploreRun(id: first.id, nodes: run, counts: counts(of: run))))
            } else {
                entries.append(contentsOf: run.map(Entry.node))
            }
            run = []
            runCalls = []
        }
        for node in nodes {
            switch node {
            case let .row(.toolUse(_, id, _, _, _, info)) where info.explore && info.parentToolUseId == nil && !failed.contains(id):
                run.append(node)
                runCalls.insert(id)
            case let .row(.toolResult(_, toolUseId, false, _, _)) where runCalls.contains(toolUseId):
                run.append(node)
            default:
                flush()
                entries.append(.node(node))
            }
        }
        flush()
        return entries
    }

    /// The counts of a run's calls.
    public static func counts(of nodes: [TranscriptNode]) -> ExploreCounts {
        var c = ExploreCounts()
        var files: Set<String> = []
        var answered: Set<String> = []
        var calls: [String] = []
        for node in nodes {
            switch node {
            case let .row(.toolUse(_, id, name, file, input, _)):
                calls.append(id)
                switch name {
                case "Read", "NotebookRead":
                    let path = file ?? input["file_path"]?.stringValue ?? input["notebook_path"]?.stringValue ?? id
                    files.insert(path)
                case "Grep", "Glob", "LS": c.searches += 1
                case "Bash": c.commands += 1
                default: c.lookups += 1
                }
            case let .row(.toolResult(_, toolUseId, _, _, _)):
                answered.insert(toolUseId)
            default:
                break
            }
        }
        c.files = files.count
        c.open = calls.filter { !answered.contains($0) }.count
        return c
    }
}
