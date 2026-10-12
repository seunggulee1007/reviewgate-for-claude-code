import Foundation
import Testing
@testable import ReviewGateCore

/// code-browser: any file of the project read-only, and the project search (docs/PROTOCOL.md §47).
@Suite @MainActor struct CodeBrowserTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "CodeBrowserTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, root: String = "/repo") -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: root, root: root, name: "repo", branch: "main", remoteURL: nil)
        return s
    }

    private func decode(_ json: String) throws -> EngineEvent {
        try JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8))
    }

    private func json(_ command: EngineCommand) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as! [String: Any]
    }

    /// Waits (≤ 1 s) for `condition`: `openProjectFile` loads in a task of its own.
    private func eventually(_ condition: () -> Bool) async {
        for _ in 0..<100 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func wireDecodesLenientlyAndCommandsEncode() throws {
        guard case let .projectFile(file) = try decode(#"{"type":"project_file","id":"r1","path":"src/A.java","lines":["a","b"],"isBinary":false,"truncated":true,"size":12}"#)
        else { Issue.record("not project_file"); return }
        #expect(file == ProjectFileReply(id: "r1", path: "src/A.java", lines: ["a", "b"], truncated: true, size: 12))
        #expect(EngineEvent.projectFile(file).replyId == "r1")
        let odd = try JSONDecoder().decode(ProjectFileReply.self, from: Data(#"{"path":"x","lines":"no","size":"big"}"#.utf8))
        #expect(odd.lines.isEmpty && odd.size == 0 && !odd.isBinary)

        guard case let .projectSearch(search) = try decode(#"{"type":"project_search","id":"r2","query":"tenant","matches":[{"path":"a","line":3,"text":"x"},{"path":7}],"truncated":false,"timedOut":true}"#)
        else { Issue.record("not project_search"); return }
        #expect(search.matches == [ProjectSearchMatch(path: "a", line: 3, text: "x")])   // the odd element is dropped
        #expect(search.timedOut && !search.truncated)
        #expect(EngineEvent.projectSearch(search).replyId == "r2")

        let read = try json(.projectFile(path: "src/A.java"))
        #expect(read["type"] as? String == "project_file" && read["path"] as? String == "src/A.java")
        let find = try json(.projectSearch(query: "-n", caseSensitive: true))
        #expect(find["type"] as? String == "project_search" && find["query"] as? String == "-n" && find["caseSensitive"] as? Bool == true)
        #expect(find["wholeWord"] == nil && find["limit"] == nil)
        #expect(try json(.projectSearch(query: "x", wholeWord: true, limit: 50))["limit"] as? Int == 50)
    }

    @Test func pathsBecomeRepoRelativeOrNothing() throws {
        #expect(CodeBrowserText.relativePath("/repo/src/A.java", root: "/repo") == "src/A.java")
        #expect(CodeBrowserText.relativePath("file:///repo/src/A.java", root: "/repo/") == "src/A.java")
        #expect(CodeBrowserText.relativePath("./src//A.java", root: "/repo") == "src/A.java")
        #expect(CodeBrowserText.relativePath("/elsewhere/A.java", root: "/repo") == nil)
        #expect(CodeBrowserText.relativePath("/repository/A.java", root: "/repo") == nil)
        #expect(CodeBrowserText.relativePath("../A.java", root: "/repo") == nil)
        #expect(CodeBrowserText.relativePath("  ", root: "/repo") == nil)
        #expect(CodeBrowserText.relativePath("/repo", root: "/repo") == nil)
        // /tmp is a symlink to /private/tmp: either spelling of a file inside the project is inside it.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cb-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let real = dir.resolvingSymlinksInPath().path
        #expect(CodeBrowserText.relativePath(real + "/A.java", root: dir.path) == "A.java")
        if real.hasPrefix("/private/") {
            #expect(CodeBrowserText.relativePath(String(real.dropFirst("/private".count)) + "/A.java", root: real) == "A.java")
        }
    }

    @Test func goToFileReadsALineAfterTheName() {
        #expect(CodeBrowserText.goToFileQuery("TenantService") == ("TenantService", nil))
        #expect(CodeBrowserText.goToFileQuery(" TenantService.java:120 ") == ("TenantService.java", 120))
        #expect(CodeBrowserText.goToFileQuery("src/A.ts:12:5") == ("src/A.ts", 12))
        #expect(CodeBrowserText.goToFileQuery("(TenantService.java:42)") == ("TenantService.java", 42))
        #expect(CodeBrowserText.goToFileQuery("A.java:") == ("A.java:", nil))
        #expect(CodeBrowserText.goToFileQuery("A.java:0") == ("A.java:0", nil))
        #expect(CodeBrowserText.goToFileQuery("") == ("", nil))
    }

    @Test func matchesGroupByFileAndLinesOfferTheirIdentifiers() {
        let matches = [ProjectSearchMatch(path: "a", line: 1, text: "x"), ProjectSearchMatch(path: "b", line: 2, text: "y"),
                       ProjectSearchMatch(path: "a", line: 9, text: "z")]
        #expect(CodeBrowserText.groups(matches) == [ProjectSearchGroup(path: "a", matches: [matches[0], matches[2]]),
                                                    ProjectSearchGroup(path: "b", matches: [matches[1]])])
        #expect(CodeBrowserText.identifiers(in: "    public TenantDto findTenant(Long tenantId) { return tenantRepository.findById(tenantId); }")
                == ["TenantDto", "findTenant", "Long", "tenantId", "tenantRepository", "findById"])
        #expect(CodeBrowserText.identifiers(in: "// 테넌트 조회 id 42 x1 ab") == [])
        #expect(CodeBrowserText.identifiers(in: (1...20).map { "name\($0)" }.joined(separator: " ")).count == CodeBrowserText.identifierLimit)
        #expect(CodeBrowserText.summary(ProjectSearchReply(query: "q", matches: []), files: 0) == "No matches")
        let two = ProjectSearchReply(query: "q", matches: Array(matches.prefix(2)), truncated: true)
        #expect(CodeBrowserText.summary(two, files: 2).hasPrefix("2 matches in 2 files"))
        #expect(CodeBrowserText.refusal(code: "file_not_found", fallback: "x") != "x")
        #expect(CodeBrowserText.refusal(code: "unknown_command", fallback: "x") == SessionToolsSupport.updateReason)
        #expect(CodeBrowserText.refusal(code: "search_failed", fallback: "x") == "x")
        // The engine's own refusals reach the pane in words (search_failed keeps git's line).
        let failed = EngineClientError.refused("search_failed:fatal: bad pattern", code: "search_failed")
        #expect(CodeBrowserText.message(failed).hasSuffix("fatal: bad pattern") && !CodeBrowserText.message(failed).hasPrefix("search_failed"))
        #expect(CodeBrowserText.message(EngineClientError.refused("invalid_query", code: "invalid_query")) != "invalid_query")
    }

    @Test func openingLoadsOnceMovesTheLineAndPickingAReviewFileCloses() async {
        let app = makeState()
        var asked: [EngineCommand] = []
        app.replySink = { command in
            asked.append(command)
            guard case let .projectFile(path) = command else { throw EngineClientError.refused("unknown command", code: "unknown_command") }
            return .projectFile(ProjectFileReply(path: path, lines: ["one", "two", "three"], size: 14))
        }
        #expect(!app.openProjectFile(path: "src/A.java"))   // no project yet
        app.handle(.state(snapshot(seq: 1)))
        #expect(app.openProjectFile(path: "/repo/src/A.java", line: 2))
        await eventually { app.codeBrowser.file != nil }
        #expect(app.codeBrowser.selection?.path == "src/A.java" && app.codeBrowser.selection?.line == 2)
        #expect(app.codeBrowser.file?.lines.count == 3)
        #expect(asked == [.projectFile(path: "src/A.java")])
        let tick = app.codeBrowser.selection?.tick ?? 0

        // The same file at another line: no second read, a new tick so the pane scrolls again.
        #expect(app.openProjectFile(path: "src/A.java", line: 3))
        await eventually { (app.codeBrowser.selection?.tick ?? 0) > tick }
        #expect(app.codeBrowser.selection?.line == 3 && asked.count == 1)
        #expect(app.codeBrowser.recentPaths == ["src/A.java"])

        // A file picked in the Changes list shows its diff again.
        app.selectedPath = nil
        #expect(!app.codeBrowser.isOpen && app.codeBrowser.file == nil)
        #expect(!app.openProjectFile(path: "../outside"))
    }

    @Test func aRefusalSaysWhyAndAnotherProjectClearsEverything() async {
        let app = makeState()
        app.replySink = { _ in throw EngineClientError.refused("file_not_found:src/Gone.java", code: "file_not_found") }
        app.handle(.state(snapshot(seq: 1)))
        await app.codeBrowser.open("src/Gone.java", line: nil) { try await app.reply($0) }
        #expect(app.codeBrowser.loadError == CodeBrowserText.refusal(code: "file_not_found", fallback: ""))
        #expect(app.codeBrowser.file == nil && app.codeBrowser.isOpen)
        app.codeBrowser.searchQuery = "tenant"
        app.handle(.state(snapshot(seq: 2, root: "/other")))
        #expect(!app.codeBrowser.isOpen && app.codeBrowser.loadError == nil && app.codeBrowser.recentPaths.isEmpty)
    }

    @Test func searchKeepsTheNewestReplyAndAFindInProjectIsAWholeCaseSensitiveWord() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        var asked: [EngineCommand] = []
        app.replySink = { command in
            asked.append(command)
            guard case let .projectSearch(query, _, _, _) = command else { throw EngineClientError.unexpectedReply("x") }
            return .projectSearch(ProjectSearchReply(query: query, matches: [ProjectSearchMatch(path: "a/B.java", line: 4, text: query),
                                                                             ProjectSearchMatch(path: "a/B.java", line: 8, text: query)]))
        }
        app.codeBrowser.searchQuery = "tenant"
        await app.searchProject()
        #expect(asked == [.projectSearch(query: "tenant")])
        #expect(app.codeBrowser.searchGroups.map(\.path) == ["a/B.java"] && app.codeBrowser.searchGroups[0].matches.count == 2)
        #expect(app.codeBrowser.searchedKey == CodeBrowserStore.searchKey(query: "tenant", caseSensitive: false, wholeWord: false))
        let tick = app.codeBrowser.searchPresentTick
        await app.searchProject(word: "TenantService")
        #expect(asked.last == .projectSearch(query: "TenantService", caseSensitive: true, wholeWord: true))
        #expect(app.codeBrowser.searchPresentTick == tick + 1 && app.codeBrowser.searchReply?.query == "TenantService")

        // An older reply arriving after a newer search is dropped.
        let gate = AsyncStream<Void>.makeStream()
        app.replySink = { command in
            guard case let .projectSearch(query, _, _, _) = command else { throw EngineClientError.unexpectedReply("x") }
            if query == "slow" { for await _ in gate.stream { break } }
            return .projectSearch(ProjectSearchReply(query: query, matches: [ProjectSearchMatch(path: query, line: 1, text: query)]))
        }
        app.codeBrowser.searchQuery = "slow"
        let slow = Task { await app.searchProject() }
        await eventually { app.codeBrowser.isSearching }
        app.codeBrowser.searchQuery = "fast"
        await app.searchProject()
        gate.continuation.yield()
        await slow.value
        #expect(app.codeBrowser.searchReply?.query == "fast" && !app.codeBrowser.isSearching)

        // Blank clears; a refusal says why.
        app.codeBrowser.searchQuery = "  "
        await app.searchProject()
        #expect(app.codeBrowser.searchReply == nil && app.codeBrowser.searchGroups.isEmpty)
        app.replySink = { _ in throw EngineClientError.refused("unknown command: project_search", code: "unknown_command") }
        app.codeBrowser.searchQuery = "x"
        await app.searchProject()
        #expect(app.codeBrowser.searchError == SessionToolsSupport.updateReason)
    }
}
