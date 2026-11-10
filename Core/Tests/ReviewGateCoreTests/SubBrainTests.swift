import Foundation
import Testing
@testable import ReviewGateCore

/// wave5 w5-brain: the board's sub-brain tab — the `brain` snapshot, its graph and layout, and the store (docs/PROTOCOL.md §43.2).
@Suite @MainActor struct SubBrainTests {
    private func event(_ json: String) throws -> EngineEvent {
        try JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8))
    }

    private func memory(_ name: String, _ type: BrainMemoryType, links: [String] = [], indexed: Bool = true, mtime: Double = 0,
                        session: BrainChangeKind? = nil) -> BrainMemory {
        BrainMemory(name: name, title: nil, type: type, description: "", mtime: mtime, size: 10, indexed: indexed, links: links, session: session)
    }

    @Test func snapshotDecodesLenientlyAndCommandsEncode() throws {
        guard case let .brain(snap) = try event(#"""
        {"type":"brain","id":"r1","dir":"/c/projects/-repo/memory","dirSource":"default","exists":true,
         "memories":[{"name":"feedback_small_commits","title":"small-commits","type":"feedback","description":"작게 커밋","mtime":5,"size":9,"indexed":true,
                      "links":["project_alpha"],"session":"add"},
                     {"name":"x","type":"weird"},{"type":"user"}],
         "counts":{"user":0},"hasIndex":true,"unindexed":["x"],"missing":["gone"],"brokenLinks":[{"from":"x","to":"nowhere"},{"bad":1}],
         "changes":[{"at":7,"kind":"add","name":"feedback_small_commits","type":"feedback","description":"d","by":"agent","agentType":"oh-my-claudecode:writer"},
                    {"at":6,"kind":"explode","name":"y"}],
         "tally":{"add":1,"change":0,"remove":0},"sessionCount":1,"baselineAt":1,"scannedAt":7,"watching":true}
        """#) else { Issue.record("not a brain event"); return }
        #expect(snap.id == "r1")
        #expect(snap.memories.map(\.name) == ["feedback_small_commits", "x"])   // the nameless one is dropped
        #expect(snap.memories[1].type == .other)
        #expect(snap.memories[0].session == .add)
        #expect(snap.memories[0].label == "small-commits")
        #expect(snap.brokenLinks == [BrainBrokenLink(from: "x", to: "nowhere")])
        #expect(snap.changes.count == 1)
        #expect(SubBrainText.writer(snap.changes[0]) == "writer")
        #expect(SubBrainText.writerAgentType(snap.changes[0]) == "oh-my-claudecode:writer")
        #expect(snap.count(.feedback) == 1)
        #expect(snap.watching)
        // An older / partial event still decodes.
        guard case let .brain(empty) = try event(#"{"type":"brain","dir":null}"#) else { Issue.record("not a brain event"); return }
        #expect(empty.dir == nil && empty.memories.isEmpty && !empty.exists)
        guard case let .brainMemory(text) = try event(#"{"type":"brain_memory","id":"r2","name":"a","path":"/m/a.md","text":"hi","truncated":true}"#)
        else { Issue.record("not a brain_memory event"); return }
        #expect(text.truncated && text.text == "hi" && text.id == "r2")

        let watch = try JSONSerialization.jsonObject(with: JSONEncoder().encode(EngineCommand.brain(watch: true))) as! [String: Any]
        #expect(watch["type"] as? String == "brain" && watch["watch"] as? Bool == true)
        let once = try JSONSerialization.jsonObject(with: JSONEncoder().encode(EngineCommand.brain(watch: nil))) as! [String: Any]
        #expect(once["watch"] == nil)
        let read = try JSONSerialization.jsonObject(with: JSONEncoder().encode(EngineCommand.brainRead(name: "a"))) as! [String: Any]
        #expect(read["type"] as? String == "brain_read" && read["name"] as? String == "a")
    }

    @Test func graphHasTheHubLinksAndACap() {
        let snap = BrainSnapshot(dir: "/m", exists: true, memories: [
            memory("project_a", .project, links: ["reference_b", "missing", "project_a"]),
            memory("reference_b", .reference, links: ["project_a"]),
            memory("user_c", .user, indexed: false),
        ], hasIndex: true)
        let g = SubBrainGraph.build(snap)
        #expect(g.nodes.first?.isHub == true)
        #expect(g.nodes.map(\.id) == ["MEMORY.md", "user_c", "project_a", "reference_b"])   // kinds in board order, then names
        #expect(g.edges.filter { !$0.isIndex }.count == 1)   // a↔b once, no self link, no missing target
        #expect(g.edges.filter(\.isIndex).count == 2)        // c is not in MEMORY.md
        #expect(g.nodes.first { $0.id == "project_a" }?.degree == 2)
        // A type turned off leaves the graph; without an index there is no hub.
        let noUser = SubBrainGraph.build(snap, hiddenTypes: [.user])
        #expect(!noUser.nodes.contains { $0.id == "user_c" })
        var plain = snap
        plain.hasIndex = false
        #expect(SubBrainGraph.build(plain).nodes.allSatisfy { !$0.isHub })
        // Over the cap: changed this session first, then the most linked, then the newest; the rest are "N개 더".
        var many: [BrainMemory] = (0..<10).map { memory("reference_\($0)", .reference, mtime: Double($0)) }
        many.append(memory("project_hot", .project, mtime: -1, session: .add))
        many[0].links = ["reference_1"]
        let capped = SubBrainGraph.build(BrainSnapshot(dir: "/m", exists: true, memories: many), maxNodes: 3)
        #expect(capped.hidden == 8)
        #expect(Set(capped.nodes.map(\.id)) == ["project_hot", "reference_0", "reference_1"])
    }

    @Test func layoutIsDeterministicInBoundsAndPullsLinkedMemoriesTogether() {
        var memories: [BrainMemory] = (0..<24).map { memory("reference_\($0)", .reference) }
        memories[0].links = ["reference_1"]
        memories[2].links = ["reference_3"]
        let g = SubBrainGraph.build(BrainSnapshot(dir: "/m", exists: true, memories: memories, hasIndex: true))
        let a = SubBrainLayout.layout(g, width: 800, height: 600, seed: 3)
        let b = SubBrainLayout.layout(g, width: 800, height: 600, seed: 3)
        #expect(a == b)
        #expect(a.count == g.nodes.count)
        #expect(a.allSatisfy { $0.x >= 24 && $0.x <= 776 && $0.y >= 24 && $0.y <= 576 && $0.x.isFinite && $0.y.isFinite })
        #expect(a[0] == BrainPoint(x: 400, y: 300))   // the hub stays in the middle
        func dist(_ p: BrainPoint, _ q: BrainPoint) -> Double { ((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y)).squareRoot() }
        let index = Dictionary(uniqueKeysWithValues: g.nodes.enumerated().map { ($1.id, $0) })
        let linked = dist(a[index["reference_0"]!], a[index["reference_1"]!])
        var others: [Double] = []
        for i in 4..<24 { for j in (i + 1)..<24 { others.append(dist(a[index["reference_\(i)"]!], a[index["reference_\(j)"]!])) } }
        let mean = others.reduce(0, +) / Double(others.count)
        #expect(linked < mean)
        #expect(SubBrainLayout.layout(.empty).isEmpty)
        // A star around MEMORY.md (every memory indexed, few links) stays off the frame: nothing ends pinned to its edge.
        for count in [40, 140] {
            let star = SubBrainGraph.build(BrainSnapshot(dir: "/m", exists: true, memories: (0..<count).map { memory("project_\($0)", .project) }, hasIndex: true))
            let pts = SubBrainLayout.layout(star)
            #expect(pts.filter { $0.x <= 24.5 || $0.x >= 975.5 || $0.y <= 24.5 || $0.y >= 675.5 }.isEmpty)
        }
        #expect(SubBrainLayout.layout(BrainGraph(nodes: [BrainGraphNode(id: "x", label: "x", type: .user, degree: 0)], edges: [], hidden: 0),
                                      width: 100, height: 50) == [BrainPoint(x: 50, y: 25)])
    }

    @Test func storeWatchesSelectsAndKnowsAnOlderEngine() async {
        let store = SubBrainStore()
        var sent: [EngineCommand] = []
        let snap = BrainSnapshot(dir: "/m", exists: true, memories: [memory("project_a", .project)], watching: true)
        store.send = { cmd in
            sent.append(cmd)
            switch cmd {
            case .brain: return .brain(snap)
            case let .brainRead(name): return .brainMemory(BrainMemoryText(name: name, path: "/m/\(name).md", text: "body"))
            default: throw EngineClientError.stopped
            }
        }
        await store.start(nil)
        #expect(store.snapshot == snap)
        await store.select("project_a")
        #expect(store.selectedText?.text == "body")
        #expect(store.selectedMemory?.name == "project_a")
        await store.select(SubBrainGraph.hubId)   // the hub has no text of its own
        #expect(store.selectedText == nil)
        await store.stop()
        #expect(sent == [.brain(watch: true), .brainRead(name: "project_a"), .brain(watch: false)])
        // The memory went away in a later snapshot: the panel closes.
        await store.select("project_a")
        store.apply(BrainSnapshot(dir: "/m", exists: true, memories: []))
        #expect(store.selected == nil)

        let old = SubBrainStore()
        old.send = { _ in throw EngineClientError.refused("unknown command: brain", code: "unknown_command") }
        await old.start(nil)
        #expect(old.unsupported)
        #expect(old.snapshot == nil)
    }

    @Test func wordsForKindsAndWriters() {
        #expect(SubBrainText.agentName("oh-my-claudecode:executor") == "executor")
        #expect(SubBrainText.agentName("general-purpose") == "general")
        #expect(SubBrainText.writer(BrainChange(at: 1, kind: .add, name: "a", by: .main)) == "Claude")
        #expect(SubBrainText.writerAgentType(BrainChange(at: 1, kind: .add, name: "a", by: .main)) == nil)
        // The board's faces (§43.1) beside the writer: Claude's star, the type's face, none from outside.
        #expect(SubBrainText.writerAvatar(BrainChange(at: 1, kind: .add, name: "a", by: .main)) == .main)
        #expect(SubBrainText.writerAvatar(BrainChange(at: 1, kind: .add, name: "a", by: .agent, agentType: "oh-my-claudecode:writer"))
            == AgentAvatar.of(type: "oh-my-claudecode:writer"))
        #expect(SubBrainText.writerAvatar(BrainChange(at: 1, kind: .add, name: "a", by: .agent, agentType: "oh-my-claudecode:writer"))?.icon == .pencil)
        #expect(SubBrainText.writerAvatar(BrainChange(at: 1, kind: .add, name: "a", by: .external)) == nil)
        #expect(Set(BrainMemoryType.allCases.map(SubBrainText.colorIndex)).count == BrainMemoryType.allCases.count)
        #expect(BrainMemoryType(lenient: "Feedback") == .feedback)
        #expect(BrainMemoryType(lenient: nil) == .other)
        #expect(SubBrainText.readable("---\nname: a\ntype: user\n---\n\nbody line\n") == "body line")
        #expect(SubBrainText.readable("no frontmatter") == "no frontmatter")
        #expect(SubBrainText.readable("---\nname: only\n---\n") == "---\nname: only\n---\n")   // nothing but frontmatter: as it is
        #expect(SubBrainText.readable("---\nunclosed") == "---\nunclosed")
    }
}
