import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §74: clone from git — the wire, the refusals in the user's words, the progress, the task's clone link.
@Suite @MainActor struct CloneProjectTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "CloneProjectTests.\(UUID().uuidString)")! }

    @Test func theWireShapes() throws {
        func json(_ c: EngineCommand) throws -> [String: Any] {
            try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(c)) as? [String: Any])
        }
        let preview = try json(.projectClonePreview(url: "acme/widgets", name: nil, parent: "/work/acme", paths: ["/work/acme/w"]))
        #expect(preview["type"] as? String == "project_clone_preview" && preview["url"] as? String == "acme/widgets"
            && preview["parent"] as? String == "/work/acme" && preview["paths"] as? [String] == ["/work/acme/w"] && preview["name"] == nil)
        let clone = try json(.projectClone(url: "acme/widgets", name: "widgets-copy", branch: "dev"))
        #expect(clone["type"] as? String == "project_clone" && clone["name"] as? String == "widgets-copy" && clone["branch"] as? String == "dev" && clone["parent"] == nil)
        let cancel = try json(.projectCloneCancel)
        #expect(cancel["type"] as? String == "project_clone_cancel" && cancel.count == 1)

        let d = JSONDecoder()
        let raw = #"{"type":"project_clone_preview","id":"7","url":"https://github.com/acme/widgets.git","repo":"acme/widgets","host":"github.com","branch":null,"name":"widgets","parent":"/Users/dev/ReviewGate","path":"/Users/dev/ReviewGate/widgets","matches":["/work/acme/widgets"]}"#
        guard case let .projectClonePreview(p) = try d.decode(EngineEvent.self, from: Data(raw.utf8)) else { Issue.record("not project_clone_preview"); return }
        #expect(p.id == "7" && p.repo == "acme/widgets" && p.host == "github.com" && p.branch == nil && p.matches == ["/work/acme/widgets"])
        guard case let .projectCloneProgress(g) = try d.decode(EngineEvent.self, from: Data(#"{"type":"project_clone_progress","path":"/w","phase":"receiving","percent":43,"phasePercent":45,"detail":"1.20 MiB | 512.00 KiB/s"}"#.utf8)) else { Issue.record("not progress"); return }
        #expect(g == ProjectCloneProgress(path: "/w", phase: .receiving, percent: 43, phasePercent: 45, detail: "1.20 MiB | 512.00 KiB/s"))
        // A step this app does not know yet reads as the first one rather than dropping the event.
        guard case let .projectCloneProgress(u) = try d.decode(EngineEvent.self, from: Data(#"{"type":"project_clone_progress","path":"/w","phase":"later","percent":140}"#.utf8)) else { Issue.record("not progress"); return }
        #expect(u.phase == .connecting && u.percent == 100)
        guard case let .projectCloned(c) = try d.decode(EngineEvent.self, from: Data(#"{"type":"project_cloned","path":"/w"}"#.utf8)) else { Issue.record("not project_cloned"); return }
        #expect(c.path == "/w")
    }

    @Test func eachRefusalInTheUsersWords() {
        #expect(EngineMessages.refusal(code: "clone_auth_failed", error: "clone_auth_failed:Authentication failed").contains("gh auth login"))
        #expect(EngineMessages.refusal(code: "clone_auth_failed", error: "x").contains("SSH"))
        #expect(EngineMessages.refusal(code: "clone_not_found", error: "clone_not_found:Repository not found.").contains("not found"))
        #expect(EngineMessages.refusal(code: "clone_network", error: "clone_network:Could not resolve host").contains("network"))
        #expect(EngineMessages.refusal(code: "clone_folder_exists", error: "clone_folder_exists").contains("folder"))
        #expect(EngineMessages.refusal(code: "git_missing", error: "git_missing").contains("xcode-select"))
        #expect(EngineMessages.refusal(code: "clone_timeout", error: "clone_timeout").contains("2 minutes"))
        #expect(EngineMessages.refusal(code: "clone_branch_not_found", error: "clone_branch_not_found:x").contains("branch"))
        #expect(EngineMessages.refusal(code: "url_has_credentials", error: "url_has_credentials").contains("token"))
        #expect(EngineMessages.refusal(code: "bad_url", error: "bad_url:spaces").contains("owner/repo"))
        #expect(EngineMessages.refusal(code: "clone_failed", error: "clone_failed:something odd") == "git clone failed: something odd")
    }

    @Test func thePhasesAndTheTasksCloneLink() {
        #expect(Set(ClonePhase.allCases.map(CloneProjectText.phase)).count == ClonePhase.allCases.count)
        #expect(CloneProjectText.cloneURL(forTask: "https://ghe.example.com/team/app/issues/9", repo: "team/app") == "https://ghe.example.com/team/app.git")
        #expect(CloneProjectText.cloneURL(forTask: "fix https://github.com/acme/widgets/issues/42 today", repo: "acme/widgets") == "https://github.com/acme/widgets.git")
        #expect(CloneProjectText.cloneURL(forTask: "acme/widgets#7", repo: "acme/widgets") == "acme/widgets")
    }

    @Test func previewAndCloneOutcomes() async {
        let d = defaults()
        AppSettings.setNewProjectParent("/work/acme", defaults: d)
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d)
        var asked: [EngineCommand] = []
        let ready = ProjectClonePreviewReply(url: "https://github.com/acme/widgets.git", repo: "acme/widgets", host: "github.com", name: "widgets", parent: "/work/acme", path: "/work/acme/widgets")
        store.replySink = { command in
            asked.append(command)
            if case .projectClonePreview = command { return .projectClonePreview(ready) }
            return .projectCloned(ProjectClonedReply(path: "/work/acme/widgets"))
        }
        #expect(await store.clonePreview(url: "acme/widgets", name: nil, paths: ["/work/acme/old"]) == .ready(ready))
        #expect(await store.cloneProject(url: "acme/widgets", name: "widgets", branch: nil, expected: URL(fileURLWithPath: "/work/acme/widgets")) == .opened)
        #expect(asked == [.projectClonePreview(url: "acme/widgets", name: nil, parent: "/work/acme", paths: ["/work/acme/old"]),
                          .projectClone(url: "acme/widgets", name: "widgets", parent: "/work/acme", branch: nil)])

        store.replySink = { _ in throw EngineClientError.refused("clone_cancelled", code: "clone_cancelled") }
        #expect(await store.cloneProject(url: "acme/widgets", name: nil, branch: nil, expected: URL(fileURLWithPath: "/work/acme/widgets")) == .cancelled)
        store.replySink = { _ in throw EngineClientError.refused("clone_not_found:Repository not found.", code: "clone_not_found") }
        guard case let .failed(why) = await store.cloneProject(url: "acme/nope", name: nil, branch: nil, expected: URL(fileURLWithPath: "/work/acme/nope")) else { Issue.record("not failed"); return }
        #expect(why.contains("Repository not found"))
        // An engine before §74: a reason, never a preview that waits forever.
        store.replySink = { _ in throw EngineClientError.refused("unknown command: project_clone_preview", code: "unknown_command") }
        guard case let .unavailable(old) = await store.clonePreview(url: "acme/widgets", name: nil, paths: []) else { Issue.record("no reason"); return }
        #expect(old.contains("update ReviewGate"))
    }

    @Test func progressGoesToTheStore() {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults())
        #expect(store.cloneProgress == nil)
        store.handle(.projectCloneProgress(ProjectCloneProgress(path: "/w", phase: .resolving, percent: 90)))
        #expect(store.cloneProgress?.phase == .resolving && store.cloneProgress?.percent == 90)
    }
}
