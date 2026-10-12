import Foundation

// MARK: wave7 w7-chat — docs/PROTOCOL.md §45.1: the chat's row tree (subagent groups), its folded exploration runs, the
// tool-call index, the row positions and each answer's turn, kept up to date row by row. An appended row goes where a full
// build would put it (its group, the run it joins) without touching the rest; rows put in front, replaced or removed — and
// the rare row that would move an earlier one (a result or a subagent row that came before its call, an error that takes a
// call out of its run, a call id seen twice) — rebuild it all. TranscriptModelTests checks it against the full build.

public struct TranscriptModel: Sendable {
    /// `TranscriptNode.build` of the rows.
    public private(set) var nodes: [TranscriptNode] = []
    /// `ExploreFold.fold(nodes)`.
    public private(set) var entries: [ExploreFold.Entry] = []
    public private(set) var index = TranscriptIndex([])
    /// Row id → its position in the rows.
    public private(set) var positions: [UUID: Int] = [:]
    /// Claude's answer rows → the turn of the prompt before them (`SideTrust.turnBefore`).
    public private(set) var answerTurns: [UUID: Int] = [:]
    /// The newest turn summary row (§43.5: the one with the "plan vs actual" basis menu).
    public private(set) var lastSummaryID: UUID?
    /// How often it was built from scratch.
    public private(set) var rebuilds = 0

    // The rows it reflects: an append keeps the first id and the old last id where they were.
    private var count = 0
    private var firstID: UUID?
    private var lastID: UUID?
    private var lastTurn: Int?
    /// Off while two rows carry the same call id (the build puts such a call's rows in two places).
    private var appendable = true

    // The tree, as the build sees it.
    private var parentOf: [String: String] = [:]
    private var agentCalls: Set<String> = []
    private var callIds: Set<String> = []
    private var resultIds: Set<String> = []
    /// Every call id a row names as its parent.
    private var namedParents: Set<String> = []
    /// Agent call → where its group is in `nodes` (an append never moves a node).
    private var groupPaths: [String: [Int]] = [:]

    // The fold, its last run kept open.
    private var failed: Set<String> = []
    /// Every call a run took (the open one included).
    private var foldedCalls: Set<String> = []
    private var tail: [TranscriptNode] = []
    private var tailCalls: Set<String> = []
    private var tailStart = 0
    private var tailRendered = true
    /// Top-level group node → its entry.
    private var groupEntries: [Int: Int] = [:]

    public init() {}

    public init(_ items: [ChatItem]) {
        rebuild(items)
    }

    /// Brings the model up to `items`. Rows only appended since the last update are placed one by one; anything else
    /// rebuilds. Returns false when it rebuilt.
    @discardableResult
    public mutating func update(_ items: [ChatItem]) -> Bool {
        let n = items.count
        if n == count, items.first?.id == firstID, items.last?.id == lastID { return true }
        guard appendable, count > 0, n > count, items[0].id == firstID, items[count - 1].id == lastID else {
            rebuild(items)
            return false
        }
        for position in count..<n {
            guard append(items[position], at: position) else {
                rebuild(items)
                return false
            }
        }
        count = n
        lastID = items[n - 1].id
        return true
    }

    // MARK: Full build

    private mutating func rebuild(_ items: [ChatItem]) {
        let builds = rebuilds + 1
        self = TranscriptModel()
        rebuilds = builds
        count = items.count
        firstID = items.first?.id
        lastID = items.last?.id
        nodes = TranscriptNode.build(items)
        positions.reserveCapacity(items.count)
        for (position, item) in items.enumerated() { note(item, at: position) }
        for item in items {
            guard case let .toolUse(_, id, name, _, _, info) = item else { continue }
            if !callIds.insert(id).inserted { appendable = false }
            if let parent = info.parentToolUseId {
                parentOf[id] = parent
                namedParents.insert(parent)
            }
            if ToolCallRecord.isAgentTool(name) { agentCalls.insert(id) }
        }
        for item in items {
            guard case let .toolResult(_, toolUseId, _, _, info) = item else { continue }
            resultIds.insert(toolUseId)
            if let parent = info.parentToolUseId ?? parentOf[toolUseId] { namedParents.insert(parent) }
        }
        recordGroups(nodes, under: [])
        for node in nodes {
            if case let .row(.toolResult(_, toolUseId, true, _, _)) = node { failed.insert(toolUseId) }
        }
        for (i, node) in nodes.enumerated() { _ = foldStep(node, at: i, render: false) }
        renderTail()
    }

    private mutating func recordGroups(_ list: [TranscriptNode], under path: [Int]) {
        for (i, node) in list.enumerated() {
            guard case let .agentGroup(_, id, children, _) = node else { continue }
            if groupPaths[id] != nil { appendable = false }
            groupPaths[id] = path + [i]
            recordGroups(children, under: path + [i])
        }
    }

    /// The index, the position and the answer's turn of one row.
    private mutating func note(_ item: ChatItem, at position: Int) {
        index.append(item)
        positions[item.id] = position
        switch item {
        case let .user(_, _, meta) where meta.turn > 0:
            lastTurn = meta.turn
        case let .assistant(id, _, _, _):
            if let lastTurn { answerTurns[id] = lastTurn }
        case let .turnSummary(id, _):
            lastSummaryID = id
        default:
            break
        }
    }

    // MARK: Append

    /// Places one appended row; false when the full build would move an earlier row (the caller rebuilds).
    private mutating func append(_ item: ChatItem, at position: Int) -> Bool {
        switch item {
        case let .toolUse(_, id, name, _, _, info):
            let isAgent = ToolCallRecord.isAgentTool(name)
            // Its result or a subagent row came first, the id is not new, or it names itself: the build places those.
            guard !callIds.contains(id), !resultIds.contains(id), !(isAgent && namedParents.contains(id)), info.parentToolUseId != id else {
                return false
            }
            callIds.insert(id)
            if let parent = info.parentToolUseId {
                parentOf[id] = parent
                namedParents.insert(parent)
            }
            if isAgent { agentCalls.insert(id) }
            note(item, at: position)
            let owner = info.parentToolUseId.flatMap { agentCalls.contains($0) ? $0 : nil }
            let node: TranscriptNode = isAgent ? .agentGroup(call: item, toolUseId: id, children: [], result: nil) : .row(item)
            return place(node, under: owner, group: isAgent ? id : nil)
        case let .toolResult(_, toolUseId, _, _, info):
            let parent = info.parentToolUseId ?? parentOf[toolUseId]
            resultIds.insert(toolUseId)
            if let parent { namedParents.insert(parent) }
            note(item, at: position)
            if agentCalls.contains(toolUseId) {
                // An agent call's result closes its group (the last one wins, as in the build).
                guard let path = groupPaths[toolUseId], Self.modifyGroup(&nodes, at: path[...], { _, result in result = item }) else { return false }
                return refreshEntry(ofRoot: path[0])
            }
            return place(.row(item), under: parent.flatMap { agentCalls.contains($0) ? $0 : nil }, group: nil)
        default:
            note(item, at: position)
            return place(.row(item), under: nil, group: nil)
        }
    }

    /// At the top level (through the fold) or at the end of its group's rows.
    private mutating func place(_ node: TranscriptNode, under owner: String?, group: String?) -> Bool {
        guard let owner else {
            nodes.append(node)
            let i = nodes.count - 1
            if let group { groupPaths[group] = [i] }
            return foldStep(node, at: i, render: true)
        }
        guard let path = groupPaths[owner] else { return false }
        var child = 0
        guard Self.modifyGroup(&nodes, at: path[...], { children, _ in
            children.append(node)
            child = children.count - 1
        }) else { return false }
        if let group { groupPaths[group] = path + [child] }
        return refreshEntry(ofRoot: path[0])
    }

    /// Changes the group at `path` (its rows, its result) and every group above it.
    private static func modifyGroup(_ list: inout [TranscriptNode], at path: ArraySlice<Int>,
                                    _ body: (inout [TranscriptNode], inout ChatItem?) -> Void) -> Bool {
        guard let i = path.first, list.indices.contains(i), case .agentGroup(let call, let id, var children, var result) = list[i] else {
            return false
        }
        if path.count == 1 {
            body(&children, &result)
        } else if !modifyGroup(&children, at: path.dropFirst(), body) {
            return false
        }
        list[i] = .agentGroup(call: call, toolUseId: id, children: children, result: result)
        return true
    }

    /// A top-level group changed: its entry shows the new node.
    private mutating func refreshEntry(ofRoot root: Int) -> Bool {
        guard let entry = groupEntries[root], entries.indices.contains(entry), nodes.indices.contains(root) else { return false }
        entries[entry] = .node(nodes[root])
        return true
    }

    // MARK: Fold

    /// One top-level node through `ExploreFold.fold`'s loop, the last run kept open. false: an error result of a call a run
    /// already took — the build checks errors first and would not have folded it.
    private mutating func foldStep(_ node: TranscriptNode, at i: Int, render: Bool) -> Bool {
        if case let .row(.toolResult(_, toolUseId, true, _, _)) = node {
            if foldedCalls.contains(toolUseId) { return false }
            failed.insert(toolUseId)
        }
        switch node {
        case let .row(.toolUse(_, id, _, _, _, info)) where info.explore && info.parentToolUseId == nil && !failed.contains(id):
            tail.append(node)
            tailCalls.insert(id)
            foldedCalls.insert(id)
            tailRendered = false
        case let .row(.toolResult(_, toolUseId, false, _, _)) where tailCalls.contains(toolUseId):
            tail.append(node)
            tailRendered = false
        default:
            renderTail()
            tail = []
            tailCalls = []
            if node.isGroup { groupEntries[i] = entries.count }
            entries.append(.node(node))
            tailStart = entries.count
            return true
        }
        if render { renderTail() }
        return true
    }

    /// The open run's entries: one folded row from `ExploreFold.minCalls` calls on, else its rows as they are.
    private mutating func renderTail() {
        guard !tailRendered else { return }
        tailRendered = true
        entries.removeSubrange(tailStart...)
        if tailCalls.count >= ExploreFold.minCalls, let first = tail.first {
            entries.append(.run(ExploreRun(id: first.id, nodes: tail, counts: ExploreFold.counts(of: tail))))
        } else {
            entries.append(contentsOf: tail.map(ExploreFold.Entry.node))
        }
    }
}

/// MARK: wave7 w7-chat — §45.1: one transcript's model and what the chat derives from it, once per row change: the files each
/// agent group's edits changed, the first line of each agent report, the text ⌘F searches in a tool row. `AppState` keeps
/// the running chat's (`liveLookups`); the chat keeps one for another chat it shows.
@MainActor
public final class TranscriptLookups {
    public private(set) var model = TranscriptModel()
    private var key: AnyHashable?
    /// Agent call → the files its edits changed (built on first use per change).
    private var groupFiles: [String: [String]]?
    /// Result row → the report's first line (rows never change).
    private var conclusions: [UUID: String?] = [:]
    /// Tool row → what ⌘F searches (kept while a search is open: `dropSearchTexts`).
    private var searchTexts: [UUID: String] = [:]

    public init() {}

    /// Up to `items` when `key` moved (`transcriptStructureRevision`: a delta or a decision in place does not move it).
    public func update(_ items: [ChatItem], key: some Hashable) {
        let key = AnyHashable(key)
        guard self.key != key else { return }
        self.key = key
        if !model.update(items) {
            conclusions = [:]
            searchTexts = [:]
        }
        groupFiles = nil
    }

    /// The row's position in the rows the model was built from.
    public func position(of id: UUID) -> Int? { model.positions[id] }

    /// `AgentGlance.groupFiles(index, under:)` for every group at once.
    public func groupFiles(under toolUseId: String) -> [String] {
        if groupFiles == nil { groupFiles = Self.filesByGroup(model.index) }
        return groupFiles?[toolUseId] ?? []
    }

    static func filesByGroup(_ index: TranscriptIndex) -> [String: [String]] {
        var sets: [String: Set<String>] = [:]
        for call in index.calls.values where ToolCallRecord.editTools.contains(call.name) {
            guard let file = call.file else { continue }
            for ancestor in index.ancestors(of: call.toolUseId) { sets[ancestor.toolUseId, default: []].insert(file) }
        }
        return sets.mapValues { $0.sorted() }
    }

    /// `AgentGlance.conclusionLine(text)` of the result row `row`, worked out once.
    public func conclusion(row: UUID, text: String?) -> String? {
        if let cached = conclusions[row] { return cached }
        let line = AgentGlance.conclusionLine(text)
        conclusions[row] = line
        return line
    }

    /// `TranscriptSearch.searchableText(item)`; a tool call's (its input as JSON) is worked out once.
    public func searchText(_ item: ChatItem) -> String? {
        guard case .toolUse = item else { return TranscriptSearch.searchableText(item) }
        if let cached = searchTexts[item.id] { return cached }
        let text = TranscriptSearch.searchableText(item)
        searchTexts[item.id] = text
        return text
    }

    /// The search closed: the tool rows' texts are not kept.
    public func dropSearchTexts() {
        searchTexts = [:]
    }
}
