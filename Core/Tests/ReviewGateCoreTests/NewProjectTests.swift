import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §69: starting without a folder — the wire, the parent setting, the create and the preselected project.
@Suite @MainActor struct NewProjectTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "NewProjectTests.\(UUID().uuidString)")! }
    private func snapshot() -> ReviewState {
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/work/acme/todo", root: "/work/acme/todo", name: "todo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s1", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: .idle, canSend: true, canRequestChanges: false, blockedReason: nil, collectError: nil, pendingCount: 0,
                          changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil,
                          changedOutside: [], ignoredTouched: [], filteredByPattern: [], restored: false)
        s.sessions = SessionsInfo(list: [SessionMeta(id: "s1", title: "New chat", turns: 0)], currentId: "s1", openTabIds: ["s1"])
        return s
    }

    @Test func theWireShapes() throws {
        func json(_ c: EngineCommand) throws -> [String: Any] {
            try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(c)) as? [String: Any])
        }
        let name = try json(.projectName(text: "Build a todo app"))
        #expect(name["type"] as? String == "project_name" && name["text"] as? String == "Build a todo app" && name["parent"] == nil)
        let create = try json(.projectCreate(name: "todo", parent: "/work/acme"))
        #expect(create["type"] as? String == "project_create" && create["name"] as? String == "todo" && create["parent"] as? String == "/work/acme")
        let match = try json(.projectMatch(ref: "acme/widgets#1", paths: ["/work/acme/widgets"]))
        #expect(match["type"] as? String == "project_match" && match["paths"] as? [String] == ["/work/acme/widgets"])

        let d = JSONDecoder()
        guard case let .projectName(n) = try d.decode(EngineEvent.self, from: Data(#"{"type":"project_name","id":"1","name":"todo","parent":"/Users/dev/ReviewGate","path":"/Users/dev/ReviewGate/todo-2"}"#.utf8)) else { Issue.record("not project_name"); return }
        #expect(n.path == "/Users/dev/ReviewGate/todo-2" && n.id == "1")
        guard case let .projectCreated(c) = try d.decode(EngineEvent.self, from: Data(#"{"type":"project_created","path":"/Users/dev/ReviewGate/todo"}"#.utf8)) else { Issue.record("not project_created"); return }
        #expect(c.path == "/Users/dev/ReviewGate/todo")
        guard case let .projectMatches(m) = try d.decode(EngineEvent.self, from: Data(#"{"type":"project_matches","repo":null,"matches":[],"guess":null}"#.utf8)) else { Issue.record("not project_matches"); return }
        #expect(m == ProjectMatchesReply())
    }

    @Test func theParentSettingAndItsSearchEntry() {
        let d = defaults()
        #expect(AppSettings.newProjectParent(defaults: d) == nil)
        AppSettings.setNewProjectParent("  /work/acme  ", defaults: d)
        #expect(AppSettings.newProjectParent(defaults: d) == "/work/acme")
        AppSettings.setNewProjectParent("", defaults: d)
        #expect(AppSettings.newProjectParent(defaults: d) == nil)
        #expect(AppSettings.defaultNewProjectParent.hasSuffix("/ReviewGate"))
        #expect(SettingsCatalog.entry("newProjectParent")?.pane == .general)
        #expect(SettingsCatalog.search("new projects").map(\.id).contains("newProjectParent"))
    }

    @Test func theRefusalsInTheUsersWords() {
        #expect(EngineMessages.refusal(code: "bad_parent", error: "bad_parent:code").contains("Settings"))
        #expect(EngineMessages.refusal(code: "parent_not_writable", error: "parent_not_writable:EACCES: permission denied").contains("EACCES"))
    }

    @Test func theNamePreviewSaysWhyWhenTheEngineCannotGiveOne() async {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        store.replySink = { _ in .projectName(ProjectNameReply(name: "todo", parent: "/work/acme", path: "/work/acme/todo")) }
        #expect(await store.newProjectName(text: "todo") == .ready(ProjectNameReply(name: "todo", parent: "/work/acme", path: "/work/acme/todo")))
        // An engine before §69: a reason, never a preview that waits forever.
        store.replySink = { _ in throw EngineClientError.refused("unknown command: project_name", code: "unknown_command") }
        guard case let .unavailable(old) = await store.newProjectName(text: "todo") else { Issue.record("no reason for an old engine"); return }
        #expect(old.contains("update ReviewGate"))
        store.replySink = { _ in throw EngineClientError.refused("bad_parent:code", code: "bad_parent") }
        guard case let .unavailable(parent) = await store.newProjectName(text: "todo") else { Issue.record("no reason for a bad parent"); return }
        #expect(parent.contains("Settings"))
    }

    @Test func thePreselectedProjectAndTheKeys() {
        let recent = ["/work/acme/a", "/work/acme/b"]
        #expect(ProjectMatchesReply(guess: "/work/acme/b").preselect(in: recent) == "/work/acme/b")
        #expect(ProjectMatchesReply(guess: "/elsewhere").preselect(in: recent) == "/work/acme/a")
        #expect(ProjectMatchesReply().preselect(in: []) == nil)
        #expect(NoProjectChoice.new.moved(-1) == .new && NoProjectChoice.new.moved(1) == .task && NoProjectChoice.open.moved(1) == .open)
    }

    @Test func createSendsTheParentAndPutsThePromptInTheComposerNeverSent() async {
        let d = defaults()
        AppSettings.setNewProjectParent("/work/acme", defaults: d)
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d)
        var asked: [EngineCommand] = []
        var fired: [EngineCommand] = []
        store.commandSink = { fired.append($0) }
        store.replySink = { command in
            asked.append(command)
            return .projectCreated(ProjectCreatedReply(path: "/work/acme/todo"))
        }
        let why = await store.createProject(name: "todo", expected: URL(fileURLWithPath: "/work/acme/todo"), prompt: "Build a todo app")
        #expect(why == nil)
        #expect(asked == [.projectCreate(name: "todo", parent: "/work/acme")])
        store.handle(.state(snapshot()))
        for _ in 0..<20 where store.taskForComposer == nil { try? await Task.sleep(for: .milliseconds(100)) }
        #expect(store.taskForComposer?.text == "Build a todo app")
        #expect(!fired.contains { if case .send = $0 { return true }; return false })

        store.replySink = { _ in throw EngineClientError.refused("parent_not_writable:EACCES", code: "parent_not_writable") }
        let refused = await store.createProject(name: "todo", expected: URL(fileURLWithPath: "/work/acme/todo"), prompt: "x")
        #expect(refused?.contains("EACCES") == true)
    }
}
