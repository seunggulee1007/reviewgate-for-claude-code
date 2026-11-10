import Foundation
import Testing
@testable import ReviewGateCore

/// r2-review-flow — polish P4-composer-22: the @ popover says a `list_files` failed, with a retry — never "no matching files"
/// for files that exist.
@MainActor @Suite struct ComposerMentionListTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ComposerMentionListTests.\(UUID().uuidString)")!)
    }

    private func open(_ app: AppState) {
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        app.handle(.state(s))
    }

    @Test func anAnswerHasItsFilesAndNoError() async {
        let app = makeState()
        open(app)
        app.replySink = { command in
            guard case let .listFiles(query, _) = command else { throw EngineClientError.refused("unexpected \(command.type)") }
            return .files(id: nil, query: query, items: [FileItem(path: "src/App.swift"), FileItem(path: "src", kind: .dir)])
        }
        let result = await app.listFilesResult(query: "src")
        #expect(result.items.map(\.path) == ["src/App.swift", "src"])
        #expect(result.error == nil)
        #expect(await app.listFiles(query: "src").count == 2)
    }

    @Test func aFailureSaysWhyInTheUsersWords() async {
        let app = makeState()
        open(app)
        app.replySink = { command in
            if case .listFiles = command { throw EngineClientError.refused("session_running", code: "session_running") }
            throw EngineClientError.refused("unexpected \(command.type)")
        }
        let result = await app.listFilesResult(query: "src")
        #expect(result.items.isEmpty)
        #expect(result.error == EngineClientError.refused("session_running", code: "session_running").userMessage)
        // The plain list keeps its old shape: nothing.
        #expect(await app.listFiles(query: "src").isEmpty)
    }

    @Test func withoutAProjectNothingIsAskedAndNothingFailed() async {
        let app = makeState()
        var asked = 0
        app.replySink = { command in
            asked += 1
            throw EngineClientError.refused("unexpected \(command.type)")
        }
        let result = await app.listFilesResult(query: "x")
        #expect(result.items.isEmpty && result.error == nil && asked == 0)
    }
}
