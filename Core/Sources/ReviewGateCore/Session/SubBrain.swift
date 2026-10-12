import Foundation
import Observation

// MARK: wave5 w5-brain — docs/PROTOCOL.md §43.2: the board's "서브브레인" tab — what Claude's auto memory holds, what this
// session added, and how the memories link (a graph laid out here, deterministically). Read only: the store never asks the
// engine to write anything.

// ---------------------------------------------------------------- words

public enum SubBrainText {
    public static func typeName(_ type: BrainMemoryType) -> String {
        switch type {
        case .user: String(localized: "People", bundle: .module)
        case .feedback: String(localized: "Feedback", bundle: .module)
        case .project: String(localized: "Project", bundle: .module)
        case .reference: String(localized: "Reference", bundle: .module)
        case .other: String(localized: "Other", bundle: .module)
        }
    }

    /// SF Symbol for a kind (the board's cards, legend and timeline).
    public static func symbol(_ type: BrainMemoryType) -> String {
        switch type {
        case .user: "person.crop.circle.fill"
        case .feedback: "bubble.left.and.text.bubble.right.fill"
        case .project: "folder.fill"
        case .reference: "books.vertical.fill"
        case .other: "doc.fill"
        }
    }

    /// The color slot of a kind (the views map it to a palette with a light and a dark value).
    public static func colorIndex(_ type: BrainMemoryType) -> Int {
        switch type {
        case .user: 0
        case .feedback: 1
        case .project: 2
        case .reference: 3
        case .other: 4
        }
    }

    public static func verb(_ kind: BrainChangeKind) -> String {
        switch kind {
        case .add: String(localized: "Memory added", bundle: .module)
        case .change: String(localized: "Memory changed", bundle: .module)
        case .remove: String(localized: "Memory removed", bundle: .module)
        }
    }

    /// An agent type as the board names it: without its plugin (`oh-my-claudecode:executor` → `executor`), `general-purpose` → `general`.
    public static func agentName(_ type: String) -> String {
        let bare = type.split(separator: ":").last.map(String.init) ?? type
        return bare == "general-purpose" ? "general" : bare
    }

    /// Who wrote a change: "Claude", the subagent's type, or "외부".
    public static func writer(_ change: BrainChange) -> String {
        switch change.by {
        case .main: "Claude"
        case .agent: change.agentType.map(agentName) ?? String(localized: "Subagent", bundle: .module)
        case .external: String(localized: "External", bundle: .module)
        }
    }

    /// The writer's agent type for the board's avatar (w5-board): nil for Claude itself and for an outside writer.
    public static func writerAgentType(_ change: BrainChange) -> String? {
        change.by == .agent ? change.agentType : nil
    }

    /// The writer's face beside "누가 썼나" — the agent board's avatars (§43.1): Claude's star for the main agent, the subagent
    /// type's face (a sparkly robot when the type is unknown), none for an outside writer.
    public static func writerAvatar(_ change: BrainChange) -> AgentAvatar? {
        switch change.by {
        case .main: .main
        case .agent: AgentAvatar.of(type: change.agentType ?? "")
        case .external: nil
        }
    }

    /// A memory's text as the panel shows it: the body after the frontmatter (its name, description and kind are shown above);
    /// the whole text when there is no frontmatter or no body.
    public static func readable(_ text: String) -> String {
        let lines = text.components(separatedBy: "\n")
        guard let first = lines.first, first.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\u{FEFF}", with: "") == "---",
              let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) else { return text }
        let body = lines[(end + 1)...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return body.isEmpty ? text : body
    }
}

// ---------------------------------------------------------------- the graph

public struct BrainGraphNode: Sendable, Equatable, Identifiable {
    /// The memory's name, or `SubBrainGraph.hubId` for MEMORY.md.
    public var id: String
    public var label: String
    /// nil: the MEMORY.md hub.
    public var type: BrainMemoryType?
    /// Links in and out (index edges not counted).
    public var degree: Int
    public var session: BrainChangeKind?

    public var isHub: Bool { type == nil }
}

public struct BrainGraphEdge: Sendable, Equatable, Hashable {
    public var from: Int
    public var to: Int
    /// MEMORY.md → a memory it lists (drawn faint, pulls weakly).
    public var isIndex: Bool
}

public struct BrainGraph: Sendable, Equatable {
    public var nodes: [BrainGraphNode]
    public var edges: [BrainGraphEdge]
    /// Memories left out by the node cap ("N개 더").
    public var hidden: Int

    public static let empty = BrainGraph(nodes: [], edges: [], hidden: 0)
}

public enum SubBrainGraph {
    public static let hubId = "MEMORY.md"
    /// More memories than this: the ones changed this session, then the most linked, then the newest are drawn.
    public static let maxNodes = 300

    public static func build(_ snapshot: BrainSnapshot, hiddenTypes: Set<BrainMemoryType> = [], maxNodes: Int = maxNodes) -> BrainGraph {
        let byName = Dictionary(snapshot.memories.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        var degree: [String: Int] = [:]
        for m in snapshot.memories {
            for to in m.links where byName[to] != nil && to != m.name {
                degree[m.name, default: 0] += 1
                degree[to, default: 0] += 1
            }
        }
        let candidates = snapshot.memories.filter { !hiddenTypes.contains($0.type) }
        var kept = candidates
        if candidates.count > maxNodes {
            kept = candidates.sorted { a, b in
                let sa = a.session != nil, sb = b.session != nil
                if sa != sb { return sa }
                let da = degree[a.name] ?? 0, db = degree[b.name] ?? 0
                if da != db { return da > db }
                if a.mtime != b.mtime { return a.mtime > b.mtime }
                return a.name < b.name
            }
            kept = Array(kept.prefix(max(0, maxNodes)))
        }
        kept.sort { a, b in
            let ta = SubBrainText.colorIndex(a.type), tb = SubBrainText.colorIndex(b.type)
            return ta != tb ? ta < tb : a.name < b.name
        }
        var nodes: [BrainGraphNode] = []
        let withHub = snapshot.hasIndex && kept.contains { $0.indexed }
        if withHub { nodes.append(BrainGraphNode(id: hubId, label: "MEMORY.md", type: nil, degree: 0, session: nil)) }
        for m in kept {
            nodes.append(BrainGraphNode(id: m.name, label: m.label, type: m.type, degree: degree[m.name] ?? 0, session: m.session))
        }
        var index: [String: Int] = [:]
        for (i, n) in nodes.enumerated() where !n.isHub { index[n.id] = i }
        var edges: [BrainGraphEdge] = []
        var seen = Set<[Int]>()
        for m in kept {
            guard let a = index[m.name] else { continue }
            for to in m.links {
                guard let b = index[to], a != b else { continue }
                let key = [min(a, b), max(a, b)]
                if seen.insert(key).inserted { edges.append(BrainGraphEdge(from: a, to: b, isIndex: false)) }
            }
            if withHub, m.indexed { edges.append(BrainGraphEdge(from: 0, to: a, isIndex: true)) }
        }
        return BrainGraph(nodes: nodes, edges: edges, hidden: candidates.count - kept.count)
    }
}

// ---------------------------------------------------------------- the layout

public struct BrainPoint: Sendable, Equatable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// A seeded force layout (Fruchterman–Reingold with gravity): the same graph and seed always give the same picture.
public enum SubBrainLayout {
    /// The ideal distance between nodes as a share of √(area / n), and the pull toward the middle (Electron uses the same two:
    /// with them no node of 12–300 ends pinned to the frame).
    public static let spread = 0.55
    public static let gravity = 1.0

    /// SplitMix64: a tiny deterministic generator (the jitter that breaks ties).
    struct Random {
        var state: UInt64
        mutating func next() -> Double {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            z ^= z >> 31
            return Double(z >> 11) / Double(1 << 53)
        }
    }

    public static func layout(_ graph: BrainGraph, width: Double = 1000, height: Double = 700, seed: UInt64 = 7, iterations: Int = 160) -> [BrainPoint] {
        let n = graph.nodes.count
        guard n > 0, width > 0, height > 0 else { return [] }
        let cx = width / 2, cy = height / 2
        if n == 1 { return [BrainPoint(x: cx, y: cy)] }
        let k = (width * height / Double(n)).squareRoot() * spread
        var rng = Random(state: seed)
        var xs = [Double](repeating: cx, count: n)
        var ys = [Double](repeating: cy, count: n)
        let hub = graph.nodes.first?.isHub == true ? 0 : -1
        // A golden-angle spiral (nodes are sorted by kind, so kinds start side by side) plus a little seeded jitter.
        for i in 0..<n where i != hub {
            let r = k * 0.6 * Double(i + 1).squareRoot()
            let a = Double(i) * 2.399_963 + rng.next() * 0.3
            xs[i] = cx + r * cos(a)
            ys[i] = cy + r * sin(a)
        }
        let margin = 24.0
        var t = min(width, height) / 8
        let cool = t / Double(max(1, iterations))
        var dx = [Double](repeating: 0, count: n)
        var dy = [Double](repeating: 0, count: n)
        for _ in 0..<max(0, iterations) {
            for i in 0..<n {
                dx[i] = 0
                dy[i] = 0
            }
            for i in 0..<n {
                for j in (i + 1)..<n {
                    var ddx = xs[i] - xs[j], ddy = ys[i] - ys[j]
                    var d2 = ddx * ddx + ddy * ddy
                    if d2 < 0.0001 {
                        ddx = rng.next() - 0.5
                        ddy = rng.next() - 0.5
                        d2 = ddx * ddx + ddy * ddy + 0.0001
                    }
                    let f = k * k / d2
                    dx[i] += ddx * f
                    dy[i] += ddy * f
                    dx[j] -= ddx * f
                    dy[j] -= ddy * f
                }
            }
            for e in graph.edges {
                let ddx = xs[e.from] - xs[e.to], ddy = ys[e.from] - ys[e.to]
                let d = max(0.01, (ddx * ddx + ddy * ddy).squareRoot())
                let f = d / k * (e.isIndex ? 0.15 : 1.0)
                dx[e.from] -= ddx * f
                dy[e.from] -= ddy * f
                dx[e.to] += ddx * f
                dy[e.to] += ddy * f
            }
            for i in 0..<n where i != hub {
                // Weaker sideways: the cloud fills a wide frame instead of a square in its middle.
                dx[i] += (cx - xs[i]) * gravity * (height / width)
                dy[i] += (cy - ys[i]) * gravity
                let len = max(0.01, (dx[i] * dx[i] + dy[i] * dy[i]).squareRoot())
                let step = min(len, t)
                xs[i] = min(width - margin, max(margin, xs[i] + dx[i] / len * step))
                ys[i] = min(height - margin, max(margin, ys[i] + dy[i] / len * step))
            }
            t = max(0.5, t - cool)
        }
        return (0..<n).map { BrainPoint(x: xs[$0], y: ys[$0]) }
    }
}

// ---------------------------------------------------------------- the store

/// The sub-brain the board shows: the engine's `brain` snapshots while the tab is open, and the selected memory's text.
@MainActor
@Observable
public final class SubBrainStore {
    public private(set) var snapshot: BrainSnapshot?
    /// The engine does not know `brain` (an older engine): the tab says so instead of an empty folder.
    public private(set) var unsupported = false
    public private(set) var loading = false
    /// The last request that failed, in the user's words.
    public private(set) var errorText: String?
    /// The memory shown on the right.
    public private(set) var selected: String?
    public private(set) var selectedText: BrainMemoryText?
    public private(set) var selectedError: String?
    /// Kinds the graph leaves out (the legend's toggles).
    public var hiddenTypes: Set<BrainMemoryType> = []
    /// Test seam: answers the requests instead of the engine.
    @ObservationIgnored public var send: ((EngineCommand) async throws -> EngineEvent)?
    @ObservationIgnored private weak var app: AppState?

    public init() {}

    private func request(_ command: EngineCommand) async throws -> EngineEvent {
        if let send { return try await send(command) }
        guard let app else { throw EngineClientError.stopped }
        return try await app.reply(command)
    }

    /// The tab appeared: read the folder and watch it.
    public func start(_ app: AppState?) async {
        if let app { self.app = app }
        await load(.brain(watch: true))
    }

    /// The tab went away: stop the engine's re-read (the snapshot stays for the next look).
    public func stop() async {
        guard !unsupported else { return }
        _ = try? await request(.brain(watch: false))
    }

    public func refresh() async {
        await load(.brain(watch: nil))
    }

    private func load(_ command: EngineCommand) async {
        loading = true
        defer { loading = false }
        do {
            guard case let .brain(snap) = try await request(command) else { throw EngineClientError.stopped }
            apply(snap)
            errorText = nil
        } catch {
            if (error as? EngineClientError)?.refusalCode == "unknown_command" {
                unsupported = true
                return
            }
            errorText = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        }
    }

    /// A snapshot (the reply, or an unsolicited change of a watched folder).
    public func apply(_ snap: BrainSnapshot) {
        unsupported = false
        if let old = snapshot, old.dir != snap.dir {
            selected = nil
            selectedText = nil
            selectedError = nil
        }
        snapshot = snap
        if let selected, !snap.memories.contains(where: { $0.name == selected }) {
            self.selected = nil
            selectedText = nil
        }
    }

    /// Shows one memory's text (read only); nil closes the panel.
    public func select(_ name: String?) async {
        selected = name
        selectedText = nil
        selectedError = nil
        guard let name, name != SubBrainGraph.hubId else { return }
        do {
            guard case let .brainMemory(text) = try await request(.brainRead(name: name)) else { throw EngineClientError.stopped }
            if selected == name { selectedText = text }
        } catch {
            if selected == name { selectedError = (error as? EngineClientError)?.userMessage ?? error.localizedDescription }
        }
    }

    /// The project changed: forget the old folder.
    public func reset() {
        snapshot = nil
        selected = nil
        selectedText = nil
        selectedError = nil
        errorText = nil
    }

    public func toggle(_ type: BrainMemoryType) {
        if hiddenTypes.contains(type) { hiddenTypes.remove(type) } else { hiddenTypes.insert(type) }
    }

    /// The memory under `selected` in the current snapshot.
    public var selectedMemory: BrainMemory? {
        guard let selected else { return nil }
        return snapshot?.memories.first { $0.name == selected }
    }
}
